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

import FetchManager from "fetch-manager";
import LibFetch from "fetch-manager/lib";
import { WikiApi } from "../wikidata-explore/src/lib/WikiApi.ts";
import type { w } from "../wikidata-explore/src/lib/wiki_types";

const lib_fetch = new LibFetch();
const language = "en";
const wiki = new WikiApi(language);

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
    let { paused, message, concurrency, tokens, href } = trace_data;
    let log: string[] = [];
    const det = message && message !== "queue empty";
    det && log.push(message);
    det && paused && log.push(`paused: ${paused}`);
    det && concurrency && log.push(`concurrency: ${concurrency}`);
    log.length && log.push(`tokens: ${tokens}`);
    !log.length && log.push(`Fetching: ${decodeURI(href)}\r`);
    console.log(log);
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
search("fetch").then((data) => console.log(data));

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
