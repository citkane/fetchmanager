import FetchManager from "fetchmanager";
import LibFetch from "fetchmanager/lib"; // FetchManager ships a convenience library of handler callbacks
import { WikiApi } from "./lib/WikiApi.ts";
import { Tui } from "./lib/Tui"; // Terminal User Interface (TUI)
import type { w } from "./lib/wiki_types";

const lib_fetch = new LibFetch();
const language = "en";
const wiki = new WikiApi(language);
const args = process.argv.slice(2);
const log_debug = args[0];

/* ---------------------------------------------------
 *  Set up a FetchManager instance
 * --------------------------------------------------- */
const time_period = "min";
const rpp_max = 200; // Maximum Requests Per Period (rpp) ie. the rate limit
const concurrency_max = 3; //Maximum active requests at any given time

/* Declare optional callback handlers */
const handlers: handlers = {
  /* Handles trace messages */
  trace: (trace_data) => {
    if (log_debug) return console.debug(trace_data);

    let { paused, throttled, message, concurrency, rpp, href } = trace_data;
    let log: string[] = [];
    paused && message && log.push(message);
    paused && log.push(`paused: ${paused}`);
    paused && throttled && log.push(`throttled: ${throttled}`);
    paused && concurrency && log.push(`concurrency: ${concurrency}`);
    log.length && log.push(`rpp: ${rpp}`);
    !log.length && log.push(`Fetching: ${decodeURI(href)}\r`);
    tui.log(log);
  },

  /* Provides a handler to manipulate the data returned from a response.
   * A clone of `Request` is injected to the callback to assist user logic */
  response: <K>() => {
    return async (resp, _req) => resp.json().then((data: K) => data);
  },

  /* Handles pagination results. Usage of `collect` is optional.
   * If `collect` is not used, the final returned result defaults to:
   * 1) If `response_cb` is set - `ReturnType<response_cb>[]` else
   * 2) `Response[]`
   *
   * `collect` defaults to merging `Array` type results into the final returned array
   * This default behaviour can be overidden by using `collect(data: data[], false)` so that the final result will be `data[][]`
   * */
  pager: async (resp, req, collect) => {
    const { continue: next, query } = (await resp.json()) as w.resp.search;
    if (!next) return;

    collect(query.search);
    const url = new URL(req.url);
    url.searchParams.set("continue", next.continue);
    url.searchParams.set("sroffset", String(next.sroffset));

    if (query.searchinfo?.totalhits) {
      const mssg = `Paging: ${next.sroffset} of ${query.searchinfo.totalhits}`;
      process.stdout.write(`${mssg}\r`);
    }
    return new Request(url, req);
  },

  /* Flags the queue to retry requests with 503 and 429 responses */
  retry: (resp, _req) => {
    if (resp instanceof Error) return false;

    const { status } = resp;
    return [503, 429].includes(status);
  },

  /* Handles request queue pauses after an error response - informed by the `retry` handler.
   * FetchManager ships a convenience library of user callback functions like the one used below
   * */
  wait: lib_fetch.wait.backoff_factory(),
};

/*
 * Declare a unique set of hosts to apply the rate limits to
 * */
const hosts: fm.host<"req">[] = [
  /* Handlers can optionally be set at the individual host level
   * If a handler is not defined in a request, these will apply (priority 2)
   * */
  {
    hostname: "www.wikidata.org",
    wait_cb: handlers.wait,
    retry_cb: handlers.retry,
  },
  /* or hostname can be passed as string, for example */
  "commons.wikidata.org",
];

/* Create a FetchManager instance.
 * Use it like native `fetch` with added functionality.
 * */
const fetch_wiki = new FetchManager(
  rpp_max,
  concurrency_max,
  time_period,
  hosts,
  /* Handlers can optionally be set at the hosts level
   * This will be the final handler fallback for all hosts and requests (priority 3)
   * */
  { trace_cb: handlers.trace },
).fetch;

/* ---------------------------------------------------
 *  Proceed with user application logic
 * --------------------------------------------------- */
async function search(
  term: string,
  limit?: number,
  next?: w.resp.search["continue"],
): Promise<w.search_res> {
  const req = wiki.search(term, limit, next); //, ["P31=Q3624078"]);
  const pager_cb = handlers.pager;
  const response_cb = handlers.response<w.resp.search>();

  /* The pager handler is set at the individual request level */
  const paged_params = [req, pager_cb] as const;
  /* Callbacks can optionally be set for individual requests (priority 1) */
  const fetch_params = [req, { response_cb }] as const;

  /* User can provide a type paramater describing the return type of `response_cb` or `pager_cb`*/
  return (
    limit
      ? fetch_wiki<w.resp.search>(...fetch_params)
      : fetch_wiki<w.resp.search["query"]["search"]>(...paged_params)
  ).catch((err) => {
    /* error handling remains in the user's realm if no `retry` callback handler is found.
     * If an error occurs with no `Response`, `err` will be a system error,
     * else if no Response.ok, `err` will be the `Response` instance.
     * */
    if (err instanceof Response) throw `${err.status} - ${err.statusText}`;
    throw err;
  });
}

async function explore(topic: string) {
  const req = wiki.explore(topic);
  const response_cb = handlers.response<w.resp.explore>();

  const explore_res = await fetch_wiki<w.resp.explore>(req, {
    response_cb,
  })
    .then((data) => data.entities)
    .catch(handle_err);

  const claims_entity = wiki.claims_entity(explore_res, topic);
  if (!claims_entity) return handle_parse_err(topic);

  const pids = Object.keys(claims_entity.claims);
  const props_entity = await definitions(pids);

  return { claims_entity, props_entity };
}

async function definitions(ids: string[]) {
  const batched_req = wiki.definitions(ids);
  const batched = await Promise.all(batched_req.map(fetch_batch));
  const defs_res = wiki.merge_definitions(batched.flat());
  const defs_entity = wiki.defs_entity(defs_res);
  return defs_entity ? defs_entity : handle_parse_err(ids.join(", "));

  async function fetch_batch(req: Request) {
    const response_cb = handlers.response<w.resp.defs>();
    return fetch_wiki<w.resp.defs>(req, { response_cb })
      .then((defs) => defs.entities)
      .catch(handle_err);
  }
}

function handle_err(err: any): never {
  if (err instanceof Response) throw `${err.status} - ${err.statusText}`;
  throw err;
}

function handle_parse_err(topic: string): never {
  const mssg = `Failed to parse data for ${topic}`;
  throw mssg;
}

const tui = new Tui(search, explore, definitions);
tui.init_query();

/* ---------------------------------------------------
 *  Local types below
 *  FetchManager types are under the `fm` namespace
 * --------------------------------------------------- */
type handlers = {
  retry: fm.cb.retry<"req">;
  wait: fm.cb.wait<"req">;
  trace: fm.cb.trace;
  response: <_K>() => fm.cb.resp<"req">;
  pager: fm.cb.pager<"req">;
};

export type search = typeof search;
export type explore = typeof explore;
export type definitions = typeof definitions;
export type explore_result = Awaited<ReturnType<explore>>;
export type search_result = Awaited<ReturnType<search>>;
export type def_result = Awaited<ReturnType<definitions>>;
