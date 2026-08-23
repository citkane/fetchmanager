/*
 * Copyright (C) 2026 Michael Jonker
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import FetchManager from "fetch-man";
import LibFetch from "fetch-man/lib"; // FetchManager ships a convenience library of handler callbacks
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
const rpp_max = 200;
const concurrency_max = 3;

const handlers: {
  retry: fm.cb.retry;
  wait: fm.cb.wait;
  trace: fm.cb.trace;
  response: <_K>() => fm.cb.resp;
  pager: fm.cb.pager<"req">;
} = {
  trace: (trace_data) => {
    if (log_debug) return console.debug(trace_data);

    let { paused, message, concurrency, tokens, href } = trace_data;
    let log: string[] = [];
    const det = message && message !== "queue empty";
    det && log.push(message);
    det && paused && log.push(`paused: ${paused}`);
    det && concurrency && log.push(`concurrency: ${concurrency}`);
    log.length && log.push(`tokens: ${tokens}`);
    !log.length && log.push(`Fetching: ${decodeURI(href)}\r`);
    tui.log(log);
  },

  response: <K>() => {
    return async (resp, _req) => resp.json().then((data: K) => data);
  },

  pager: async (resp, req, collect) => {
    const { continue: next, query } = (await resp.json()) as w.resp.search;
    collect(query.search);
    if (!next) return;

    const url = new URL(req.url);
    url.searchParams.set("continue", next.continue);
    url.searchParams.set("sroffset", String(next.sroffset));
    return new Request(url, req);
  },

  retry: (resp, _req) => {
    if (resp instanceof Error) return false;

    const { status } = resp;
    return [503, 429].includes(status);
  },

  wait: lib_fetch.wait.backoff_factory(),
};

const fm = new FetchManager(
  rpp_max,
  concurrency_max,
  time_period,
  ["www.wikidata.org"],
  {
    wait_cb: handlers.wait,
    retry_cb: handlers.retry,
    trace_cb: handlers.trace,
  },
);

/* ---------------------------------------------------
 *  Proceed with user application logic
 * --------------------------------------------------- */
async function search(
  term: string,
  limit?: number,
  next?: w.resp.search["continue"],
): Promise<w.search_res> {
  const req = wiki.search(term, limit, next);
  const pager_cb = handlers.pager;
  const response_cb = handlers.response<w.resp.search>();

  const paged_params = [req, pager_cb] as const;
  const fetch_params = [req, { response_cb }] as const;

  return (
    limit
      ? fm.fetch<w.resp.search>(...fetch_params)
      : fm.fetch<w.resp.search["query"]["search"]>(...paged_params)
  ).catch((err) => {
    if (err instanceof Response) throw `${err.status} - ${err.statusText}`;
    throw err;
  });
}

async function explore(topic: string) {
  const req = wiki.explore(topic);
  const response_cb = handlers.response<w.resp.explore>();

  const explore_res = await fm
    .fetch<w.resp.explore>(req, {
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
    return fm
      .fetch<w.resp.defs>(req, { response_cb })
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
 *  Local type exports
 * --------------------------------------------------- */
export type search = typeof search;
export type explore = typeof explore;
export type definitions = typeof definitions;
export type explore_result = Awaited<ReturnType<explore>>;
export type search_result = Awaited<ReturnType<search>>;
export type def_result = Awaited<ReturnType<definitions>>;
