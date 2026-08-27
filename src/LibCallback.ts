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

/// <reference path="./types.d.ts" />

/**
 * # A re-usable library of example callbacks for Fetch Manager
 * @usage
 * ```ts
 * import FetchManager from "fetch-manager"
 * import LibCalback from "fetch-manager/lib"
 *
 * const lib_cb = new LibCallback();
 * const handlers = {
 *   retry_cb: lib_cb.retry.generic_factory(),
 *   wait_cb: lib_cb.wait.backoff_factory(),
 *   response_cb: lib_cb.response.generic,
 * }
 * const fm = new FetchMnagaer(10, 10, "sec", [
 *   "api.domain.com"
 * ], handlers)
 *
 * const status = await fm.fetch<string>("https://api.domain.com/status").catch(...)
 * const dowiki = await fm.fetch<dowiki_t>("https://api.domain.com/dowiki").catch(...)
 *
 * ```
 * */
export default class LibCallback<G = fm.kind> implements fm.lib<G> {
  retry = {
    /**
     * ## A generic retry callback with additional options to limit the amount of errors or fails.
     * @param retry_status [Array<number>?] Which status's to retry for (default [429, 503])
     * @param max_err [number?] The maximum times to retry on a Error response (defaults to never retry)
     * @param max_fail [number?] The maximum times to retry on a Response.ok === false (defaults to always retry)
     * @returns [fm.cb.retry] A Fetch Manager retry_cb function
     * */
    generic_factory: (
      retry_status: number[] = [429, 503],
      max_error?: number,
      max_fail?: number,
    ) => {
      let errs = 0;
      let fails = 0;
      return (res: Response | Error) => {
        if (res instanceof Error) {
          if (!max_error) return false;
          errs++;
          return errs <= max_error;
        }
        if (retry_status.includes(res.status)) {
          if (!max_fail) return true;
          fails++;
          return fails <= max_fail;
        }
        return false;
      };
    },
  };
  wait = {
    /**
     * ## A psuedo-random backoff strategy to help keep you outside of a retry stampede on the server
     * @returns [fm.cb.wait] A Fetch Manager wait_cb function
     * */
    backoff_factory: () => {
      let count = 0;
      let ms = 0;
      let time = new Date().valueOf();
      return () => {
        count++;
        ms = Math.random() * 500 * count;
        const now = new Date().valueOf();
        if (now - time > ms * 2) {
          count--;
          time = now;
        }
        return ms;
      };
    },
    /**
     * ## Wait for a server provided time
     * @param header_key [string] The response header key to look for the wait value
     * @param val_cb [(string | null | Error) => number] Function to parse the header value to a ms `number`
     * @returns [fm.cb.wait] A Fetch Manager wait_cb function
     * @example
     * ```ts
     * const rettry_cb = ...;
     * const wait_cb = lib_cb.wait.response_factory("Retry-After", (time: string | null | Error)=>{
     *   if(!time || time instancof Error) return 5000;
     *   return Number(time) * 1000;
     * })
     * const resp = fm.fetch("https://api.domain.com/endpoint", {retry_cb, wait_cb})
     * ```
     * */
    response_factory:
      (header_key: string, val_cb: (time: string | null | Error) => number) =>
      (res: Response | Error) => {
        if (res instanceof Error) return val_cb(res);
        return val_cb(res.headers.get(header_key));
      },
  };
  response = {
    /**
     * ## Return text, json or Response depending on the "content-type" header
     * This is the actual callback, not a factory function that returns the callback.
     * Reference it directly
     * */
    generic: async (res: Response) => {
      const type = res.headers.get("content-type");
      if (!type) return res;
      if (type.includes("json")) return await res.json();
      if (type.includes("text")) return await res.text();
      return res;
    },
  };
  trace = {
    /**
     * ## Eagerly console.info the trace data
     * This is the actual callback, not a factory function that returns the callback.
     * Reference it directly
     * */
    generic: (data: fm.trace_data) => {
      console.info(data);
    },
  };
}
