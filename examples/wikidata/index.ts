import FetchManager from "fetchmanager";
import { WikiApi, type wiki } from "./WikiApi";
import { decode_html } from "./lib";

const wiki = new WikiApi();
const args = process.argv.slice(2);
const log_debug = args[0];

/* ---------------------------------------------------
 *  Set up a FetchManager instance
 * --------------------------------------------------- */
const time_period = "min";
const rpp_max = 200; // Maximum Requests Per Period (rpp) ie. the rate limit
const concurrency_max = 3; //Maximum active requests at any given time

/* Declare optional callback functions */
const callbacks: callbacks = {
  /* Trace lifecycles of requests */
  trace: {
    hosts: (trace_data) => {
      if (log_debug) console.debug(trace_data);
    },
    host: (trace_data) => {
      if (log_debug) return console.debug(trace_data);
      console.debug(trace_data.href);
    },
    fetch: (trace_data) => {
      if (log_debug) return console.debug(trace_data);
      const { paused, throttled, message, concurrency, rpp } = trace_data;
      if (paused) console.debug({ message, throttled, concurrency, rpp });
    },
  },
  /* Handle responses. A clone of `Request` is also injected to assist user logic */
  response: {
    search: async (resp, _req) => {
      return resp.json().then((data: wiki.resp.search) => data);
    },
  },
  pager: {
    search: async (resp, req, collect) => {
      const { continue: cont, query } = (await resp.json()) as wiki.resp.search;
      if (!cont) return;

      query.search.forEach((result) => collect.push(result));
      const url = new URL(req.url);
      url.searchParams.append("continue", cont.continue);
      url.searchParams.append("sroffset", String(cont.sroffset));
      return new Request(url, req);
    },
  },
};

/* Declare a unique set of hosts to apply the rate limits to */
const hosts: fm.host<"req">[] = [
  "query.wikidata.org",
  "www.wikidata.org",
  /* Callbacks can optionally be set at the individual host level (priority 2) */
  { hostname: "commons.wikidata.org", trace_cb: callbacks.trace.host },
];

/* Create a FetchManager instance */
const fetch_wiki = new FetchManager(
  rpp_max,
  concurrency_max,
  time_period,
  hosts,
  /* Callbacks can optionally be set at the hosts level (priority 3) */
  { trace_cb: callbacks.trace.hosts },
).fetch;

/* ---------------------------------------------------
 *  Proceed with user application logic
 * --------------------------------------------------- */
async function search(term: string, limit: number) {
  const { trace, response, pager } = callbacks;
  const req = wiki.search(term, undefined, limit); //, ["P31=Q3624078"]);
  /* User can provide a type paramater describing the return type of `response_cb` */
  return fetch_wiki<wiki.resp.search | wiki.resp.search["query"]["search"]>(
    req,
    /* Callbacks can optionally be set for individual requests (priority 1) */
    { trace_cb: trace.fetch, response_cb: response.search },
    pager.search!,
  ).catch((err) => {
    /* Error handling is a user responsibility.
     * If error occurs with no Response, `err` will be a system error,
     * else if no Response.ok, `err` will be `Response`
     * */
    throw err;
  });
}

search("fuck", 10).then((data) => {
  console.log(data);
  // const { continue: cont, query, batchcomplete } = data;
  // console.log({ cont, batchcomplete }, query.searchinfo);
  // query.search.
  data.forEach((result, i) => {
    const { title, snippet } = result;
    console.log(`[${i}] ${decode_html(snippet)} (${title})`);
  });
});

/* ---------------------------------------------------
 *  Local types below
 *  - FetchManager types are under the `fm` namespace
 * --------------------------------------------------- */

type callbacks = {
  trace: { [key: string]: fm.cb.trace };
  response: {
    [key: string]: fm.cb.resp<"req">;
  };
  pager: { [key: string]: fm.cb.pager<"req"> };
};
