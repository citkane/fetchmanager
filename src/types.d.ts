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

/** # FetchManager types */
namespace fm {
  type constructor = (...params: fm.opts.instance<G>) => void;
  /**
   * # defines two possible request request shapes
   * Can be:
   * - a native javascript {@link Request} instance, or
   * - a {@link fm.p.req_url}
   * The latter shape is provided for passing non-native Request options such as bun's `tls.rejectUnauthorized`.
   * Pass a custom request in the shape:
   * ```ts
   *{url:string, req_init:{...custom_stuff...} as RequestInit}
   * ````
   * */
  type req<K extends kind> = K extends "req"
    ? Request
    : K extends "url"
      ? p.req_url
      : p.req_url | Request;

  /**
   * # Defines the kind of reuest shape being acted on.
   * The Fetch Manager `fetch` method accepts a native `Request` instance or a custom definition form.
   * This gets passed into callbacks, which can be informed of the expected kind
   * @see {@link fm.req}
   * */
  type kind = "req" | "url";

  /**
   * # Time period definitions for rate calculation
   * */
  type period = "sec" | "min" | "hr" | "day";

  /**
   * # Data returned to the user trace callback function
   * @prop tokens [number] How many request tokens remain for the period
   * @prop message [string?] Information about the queue state
   * @prop paused [number?] For how many ms is the queue paused
   * @prop concurrency [number] How many requests are currently active
   * @prop max_concurrency [number] Maximum concurrent requests allowed
   * @prop max_rpp [number] The maximum amount of requests allowed for the period
   * @prop period [fm.period] "sec" | "min" | "hr" | "day"
   * @prop queue [number] The length of the request queue
   * @prop force_retry [number] The amount of retries remaining for the request
   * @prop skip_queue [boolean] Is the active request skipping the queue
   * @prop target_key [string] The key of the requests limiter bucket
   * @prop href [string] The href of the current request
   * @prop time [number] Unix Epoch (ms)
   * */
  type trace_data = {
    tokens: number;
    message?: string;
    paused?: number;
    concurrency: number;
    max_concurrency: number;
    max_rpp: number;
    period: period;
    queue: number;
    force_retry: number;
    skip_queue: boolean;
    target_key: string;
    href: string;
    time: number;
  };

  /**
   * # The limiter state for a target.
   * @prop uid [string] The uid of the target group to which the bucket belongs
   * @prop tokens [number] How many requests remain for the period
   * @prop concurrency [number] How many requests are active
   * @prop period [fm.period] (immuteable) "sec" | "min" | "hr" | "day"
   * @prop max_rpp [number] (immuteable) The maximum requests per period
   * @prop max_concurrency [number] (immuteable) The maximum concurrent requests allowed
   * @prop time [number] (immuteable) Unix Epoch (ms) of last update
   * */
  type bucket = {
    uid: string;
    tokens: number;
    concurrency: number;
    period: period;
    max_rpp: number;
    max_concurrency: number;
    time: number;
  };

  /** # User defined callback functions */
  namespace cb {
    /**
     * # Flags if a failed request should be retried.
     * Generally used to look for 503, 429, etc type responses
     * @param resp [Response | Error] The Response (or Error if no Response was received)
     * @param fm_req [fm.req] Request or {url: string, req_init?: RequestInit}
     * @returns `boolean` - true to retry, false to discard to error handling
     * @example
     * ```ts
     *  const retry_cb: fm.cb.retry = (resp, _req) => {
     *    return resp instanceof Error ? false : [503, 429].includes(resp.status);
     *  },
     * ```
     * */
    type retry<K = kind> = (resp: Response | Error, fm_req: req<K>) => boolean;

    /**
     * # Pauses the fetch queue.
     * The user logic within can be used to:  
     * - create request backoff behaviour
     * - determine absolute wait time from the server response
     * @param resp [Response | Error] the Response (or Error if no Response was received)
     * @param fm_req [fm.req] Request or {url: string, req_init?: RequestInit}
     * @returns [number] in ms to wait for
     * @example
     * ```ts
     * wait_cb: (resp, _req) => {
     *   if (resp instanceof Error) return 1000;
     *   const wait_ms = resp.headers.get("Retry-After") || "500";
     *   return Number(wait_ms);
     * },
     * ```
     * */
    type wait<K = kind> = (resp: Response | Error, fm_req: req<K>) => number;

    /**
     * # Processes a Response, returning the intended data.
     * @param resp [Response]
     * @param fm_req [fm.req] Request or {url: string, req_init?: RequestInit}
     * @returns [any]
     * @example
     * ```ts
     * const response_cb: fm.cb.resp = async (resp, _req) => {
     *   return resp.json().then((data: foo_t) => data.bar);
     * };
     * ```
     * `foo_t["bar]` can then be passed to `fm.fetch` to receive typed data directly.
     * @example
     * ```ts
     * // `data` will be typed as `foo_t["bar"]`
     * const data = await fm.fetch<foo_t["bar"]>("https://foo.com/api/bar", { response_cb });
     * ```
     * */
    type resp<K = kind> = (resp: Response, fm_req: req<K>) => any;

    /**
     * # Collects pagination results.
     * It collects an array of page results which is resolved to `fm.fetch` after pagination completes.
     * @typeParam  <K> [fm.kind] "url" or "req" describes the shape of the initial request (Request or {url: string, req_init?: RequestInit})
     * @param resp [Response]
     * @param fm_req [fm.req] Request or {url: string, req_init?: RequestInit}
     * @param collect [fm.cb.page_collector] opinionated data collector (optional).
     * @returns The user must return, sync or async, one of:
     * + The next page request: a request in the shape of <K>
     * + To stop paging: a nullish value, eg. just `return`
     * @example
     * ```ts
     * type foo_t = {next: string, data: data[]}
     * const pager_cb: fm.cb.pager<"req"> = async (resp, req, collect) => {
     *    const { next, data } = (await resp.json()) as foo_t;
     *    collect(data);                        // optional - overrides `response_cb` and flattens the resolved result
     *    if (!next) return;                    // return nullish if no more data is expected
     *
     *    const url = new URL(req.url);
     *    url.searchParams.set("next", next);
     *    return new Request(url, req);         // return a request in the shape of <K> for more data
     * };
     * // We used `collect`, so `paged_data` is also `data[]` and not `data[][]`
     * const paged_data = fm.fetch<foo_t["data"]>("https://foo.com/api/paged", pager_cb)
     * ```
     *
     * Using pager_cb will resolve an array. The array data will depend on the environment that you have created for the request.
     * Usage of {@link page_collector collect} is optional. If not used, the final result defaults to:
     * 1) If `response_cb` is set - `ReturnType<response_cb>[]` else
     * 2) `Response[]`
     *
     * `collect(data[])` defaults to flattening input arrays into the final returned array.
     * The default behaviour can be overidden by using `collect(data, false)` so that the resolved result will be `data[][]`
     */
    type pager<K = kind> = (
      resp: Response,
      fm_req: req<K>,
      collect: page_collector,
    ) => p.pager_cb_rtn<K> | Promise<p.pager_cb_rtn<K>>;

    /**
     * Data collector for paginated requests
     * The data is added to an Array which is returned as the final `Response` when pagination completes.
     * @param payload [any] The data to collect. Standard behaviour is to merge input arrays with the collection array to prevent `result[][]` types.
     * @param merge [boolean?] default = true. Set to false to prevent array merging
     * */
    type page_collector = (payload: any, merge = true) => void;

    /**
     * # Provides data about the state of the queue
     * Executed at every heartbeat if the queue is not stopped or paused.
     * Executed at error events
     * Executed at wait events
     * @param data [fm.trace_data]
     * @returns [void]
     * @example
     * ```ts
     * const trace_cb = ((data: fm.trace_data) => {
     *    my_logger.log(data)
     * })
     * ```
     */
    type trace = (data: trace_data) => void;
  }

  /** # User options */
  namespace opts {
    /**
     * # FetchManager class constructor parameters
     * @param req_max_per_period [number] Fetch rate limit for the period.
     * @param req_max_concurrent [number] Limit for maximum concurrent requests.
     * @param rpp_period_def [fm.period] Time period for fetch rate.
     * @param targets [Array<fm.opts.target>] group of targets on which to apply limits.
     * @param options [fm.opts.global?] Optional user settings
     * @param bucket [fm.bucket?] a bucket to initiate the instance with.
     * If `bucket` is given, it will override the given `req_max...` and `rpp_period_def` parameters.
     * If the given bucket does not match the given targets, an error will be thrown.
     * @example
     * ```ts
     * const fm = new FetchManager({
     *     req_max_per_period: number,             // The rate limit
     *     req_max_concurrent: number,             // Maximum concurrency
     *     rpp_period_def: fm.period,              // The period of the rate limit, "sec" | "min" | "hr" | "day"
     *     targets: [                              // The group of one or more targets to apply limits to
     *        "foo.domain.com",
     *        "foo.domain.com:3000",
     *        {
     *          target_key: "foo.domain.com/api/special",
     *          // options defined here are
     *          // fallen back on as priority (2)
     *          retry_cb?: fm.cb.retry,  
     *          wait_cb?: fm.cb.wait,
     *          trace_cb?: fm.cb.trace,
     *          abort_timeout?: 5000,              // Requests are aborted after 5 seconds
     *        }
     *     ],  
     *     options?: {                             // (optional) put bucket here
     *         wait_ms?: number,                   // Override the default (500) retry wait in ms
     *         heartbeat?: number,                 // Override the default (20) queue heartbeat in ms
     *         // options defined here are
     *         // fallen back on as priority (3)
     *         retry_cb?: fm.cb.retry,  
     *         wait_cb?: fm.cb.wait,
     *         trace_cb?: fm.cb.trace,
     *         abort_timeout?: 2000,               // Requests are aborted after 2 seconds
     *     },
     *     bucket?: fm.bucket,                     // A pre-existing bucket to initialise the instance with.
     * })
     * ````
     */
    type instance<K = kind> = instance_b | instance_f;
    type instance_b<K = kind> = [
      bucket: fm.bucket,
      targets: fm.opts.target<K>[],
      options?: fm.opts.global<K>,
    ];
    type instance_f<K = kind> = [
      max_rpp: number,
      max_concurrent: number,
      period: fm.period,
      targets: fm.opts.target<K>[],
      options?: fm.opts.global<K>,
    ];

    /**
     * # Target definition
     * Can be a string, or optionally an object including user options for the target level.
     * Target keys can be `host` or `host + pathname` (as defined by {@link URL})
     * Url's are matched against targets in order of path length - ie. the longest target path gets matched first
     * Targets can be given in any order, Fetch Manager will do the sorting.
     * @example
     * const targets: fm.opts.target[] = [
     *   "foo.domain.com",
     *   "foo.domain.com:3000",
     *   {
     *     target_key: "foo.domain.com/api/special",
     *     // options defined here are
     *     // fallen back on as priority (2)
     *     retry_cb?: fm.cb.retry,  
     *     wait_cb?: fm.cb.wait,
     *     trace_cb?: fm.cb.trace,
     *     abort_timeout?: number, // `AbortController` timeout in ms
     *   }
     * ],  
     */
    type target<K = fm.kind> = target_options<K> | string;
    type target_options<K = fm.kind> = {
      target_key: string;
      abort_timeout?: number;
    } & p.handlers<K>;

    /**
     * # User options for the class constructor.
     * @param wait_ms [number?] ms to pause before retrying a request. Default 500
     * @param heartbeat [number?] frequency in ms to poll the request queue. Default 20
     * @param abort_timeout [number?] ms for timeout signal. Defaults to system timeout
     * @param response_cb [fm.cb.resp?] User callback handler for responses
     * @param retry_cb [fm.cb.retry?] User callback handler for retry
     * @param wait_cb [fm.cb.t_out?] User callback handler for wait
     * @param trace_cb [fm.cb.trace?] User callback handler for trace
     */
    type global<K extends kind> = {
      wait_ms?: number;
      heartbeat?: number;
      abort_timeout?: number;
    } & p.handlers<K>;

    /**
     * # User options for a {@link FetchManager.fetch} method call.
     * @param skip_queue [boolean?] Sends a request to the front of the queue
     * @param force_retry [number?] Automatically retry a failed request x number of times:
     * + `-2` will retry twice from the front of the queue.
     * + `2` will retry twice from the back of the queue.
     * @param abort_timeout [number?] abort timeout in ms.  
     * @param response_cb [fm.cb.resp?] User callback handler for responses
     * @param retry_cb [fm.cb.retry?] User callback handler for retry
     * @param wait_cb [fm.cb.t_out?] User callback handler for wait
     * @param trace_cb [fm.cb.trace?] User callback handler for trace
     */
    type fetch<K extends kind> = {
      skip_queue?: boolean;
      force_retry?: number;
      abort_timeout?: number;
    } & p.handlers<K>;
  }

  /**
   * # `fetch` method overloads
   * User should not need these
   * */
  namespace fol {
    type fetch_pms<K = fm.kind> = [
      req_url: Request | string,
      options_init_page?: RequestInit | fm.opts.fetch<K> | fm.cb.pager<K>,
      options_pager_cb?: fm.opts.fetch<K> | fm.cb.pager<K>,
      pager_cb?: fm.cb.pager<K>,
    ];

    type fetch<K = fm.kind> = {
      /**
       * # A wrapper around native JS fetch with extra functionality
       * @example It can be typed with the expected data return type:
       * ```ts
       * const resp: Response = await fm.fetch(...)         // default is Response
       * const data: my_type = await fm.fetch<my_type>(
       *   ...,
       *   { response_cb },                                 // response_cb returns my_type
       *   ...
       * )
       * const data: paged[] = await fm.fetch<paged[]>(
       *  ...,
       *  pager_cb                                          // pager_cb always creates an Array
       * )
       * ```
       * @example All overloads:
       * ```ts
       * fm.fetch("url")
       * fm.fetch("url", pager_cb)
       * fm.fetch("url", {...options})
       * fm.fetch("url", {...options}, pager_cb)            // pager_cb always pages from the front of the queue
       * fm.fetch("url", {...} as RequestInit)              // Force non-native RequestInit shapes
       * fm.fetch("url", {...} as RequestInit, {...options})
       * fm.fetch("url", {...} as RequestInit, {...options}, pager_cb)
       * fm.fetch(Request)
       * fm.fetch(Request, pager_cb)
       * fm.fetch(Request, {...options})
       * fm.fetch(Request, {...options}, pager_cb)
       * ````
       * @example Options:
       * ```ts
       * {
       *     skip_queue?: boolean,                          // Send this request to the front of the queue
       *     force_retry?: number,                          // Retry request x amount of times (back of queue, -x for front)
       * // Handlers defined here
       * // are first priority (1)
       *     response_cb?: fm.cb.resp,  
       *     retry_cb?: fm.cb.retry,                        // retry_cb always retries from the front of the queue
       *     wait_cb?: fm.cb.wait,
       *     trace_cb?: fm.cb.trace,
       * }
       * ````
       * */
      <T = Response>(...p: fm.fol.r_o<K>): Promise<T>;
      <T = Response>(...p: fm.fol.r_p<K>): Promise<T>;
      <T = Response>(...p: fm.fol.r_o_p<K>): Promise<T>;
      <T = Response>(...p: fm.fol.u_i): Promise<T>;
      <T = Response>(...p: fm.fol.u_o<K>): Promise<T>;
      <T = Response>(...p: fm.fol.u_o_p<K>): Promise<T>;
      <T = Response>(...p: fm.fol.u_p<K>): Promise<T>;
      <T = Response>(...p: fm.fol.u_i_o<K>): Promise<T>;
      <T = Response>(...p: fm.fol.u_i_p<K>): Promise<T>;
      <T = Response>(...p: fm.fol.u_i_o_p<K>): Promise<T>;
    };

    type r_o<K extends fm.kind> = readonly [
      req: Request | string,
      options?: fm.opts.fetch<K>,
    ];
    type r_p<K extends fm.kind> = readonly [
      req: Request | string,
      pager_cb: fm.cb.pager<K>,
    ];
    type r_o_p<K extends fm.kind> = readonly [
      req: Request | string,
      options: fm.opts.fetch<K>,
      pager_cb: fm.cb.pager<K>,
    ];
    type u_i = readonly [url: string, init?: RequestInit];
    type u_o<K extends fm.kind> = [
      url: Request | string,
      options: fm.opts.fetch<K>,
    ];
    type u_p<K extends fm.kind> = readonly [
      url: Request | string,
      pager_cb: fm.cb.pager<K>,
    ];
    type u_o_p<K extends fm.kind> = readonly [
      url: Request | string,
      options: fm.opts.fetch<K>,
      pager_cb: fm.cb.pager<K>,
    ];
    type u_i_o<K extends fm.kind> = readonly [
      url: Request | string,
      init: RequestInit,
      options: fm.cb.fetch_opts<K>,
    ];
    type u_i_p<K extends fm.kind> = readonly [
      url: Request | string,
      init: RequestInit,
      pager_cb: fm.cb.pager<K>,
    ];
    type u_i_o_p<K extends fm.kind> = readonly [
      url: Request | string,
      init: RequestInit,
      options: fm.opts.fetch<K>,
      pager_cb: fm.cb.pager<K>,
    ];
  }

  /**
   * # Private module types
   * user should not need these
   * */
  namespace p {
    type handlers<K extends fm.kind> = {
      response_cb?: fm.cb.resp<K>;
      retry_cb?: fm.cb.retry<K>;
      wait_cb?: fm.cb.wait<K>;
      trace_cb?: fm.cb.trace;
    };

    type req_url = { url: string; req_init?: RequestInit };
    type pager_cb_rtn<K extends fm.kind> =
      fm.req<K> | undefined | null | void | false;

    type ctx<K extends fm.kind> = fm.opts.fetch<K> & {
      ctx_req: ctx_req;
      target_key: string;
      force_retry: number;
      skip_queue: boolean;
      page_collector: { user: K[]; system: Response[] };
      pager_cb?: fm.cb.pager<K>;
      resolve: resolve;
      reject: reject;
      paused?: () => void;
      abort_timeout?: number;
      aborted: () => boolean;
      user_aborted: boolean;
    };

    type fetch_fn<K extends fm.kind> = {
      execute_fetch: Function;
      get_ctx: () => ctx<K>;
      in_flight: boolean;
    };

    type ctx_pms<K extends fm.kind> = {
      url?: string;
      req?: Request;
      req_init?: RequestInit;
      options?: fm.opts.fetch<K>;
      pager_cb?: fm.cb.pager<K>;
    };

    type ctx_req = {
      url?: string;
      req_init?: RequestInit;
      req?: Request;
    };

    type limiter<K extends fm.kind> = {
      wait_ms: number;
      target_options: { [target: string]: opts.target_options<K> };
      find_target: (url: URL) => string | Error;
      reqs: limiter_reqs<K>;
      paused: limiter_paused;
      bucket: limiter_bucket;
      heartbeat_ms: number;
      heartbeat: any;
      abort_timeout?: number;
    } & handlers<K>;

    type limiter_reqs<K extends fm.kind> = {
      is_stopped: () => boolean;
      why_stopped: () => string | undefined;
      first: () => fetch_fn<G> | undefined;
      shift: () => fetch_fn<G> | undefined;
      unshift: (fn: fetch_fn<G>) => void;
      push: (fn: fetch_fn<G>) => void;
      len: () => number;
      trail_trace: () => ctx<G> | undefined;
      filter_aborted: () => fetch_fn<K>[];
    };

    type limiter_paused = {
      refr_pause: (ctx?: fm.p.ctx<G>) => boolean;
      set_pause: (ms: number, ctx: fm.p.ctx<G>) => void;
      is_paused: () => boolean;
      ms: number;
    };

    type limiter_bucket = {
      is_full: () => boolean;
      remove_token: () => void;
      replace_token: () => void;
      dec_concurrent: () => void;
      inc_concurrent: () => void;
      interval: any;
      get: () => bucket;
      set: (bucket: bucket) => void;
      kill: () => void;
      stamp_time: () => void;
      is_stopped: () => boolean;
      why_stopped: () => string | undefined;
    };

    type limiter_rpp = {
      period: fm.period;
      rate: number;
      max: number;
      throttle: () => boolean;
      increment: () => void;
    };

    type resolve = (value: unknown) => void;
    type reject = (reason?: any) => void;
  }

  /**
   * # Constructors for the callback library
   * Not a part of the main library.
   * User should not need these
   * */
  type lib<K = fm.kind> = {
    retry: {
      [key: string]: fm.cb.resp<K> | ((...p: any[]) => fm.cb.resp<K>);
    };
    wait: {
      [key: string]: fm.cb.resp<K> | ((...p: any[]) => fm.cb.resp<K>);
    };
    response: { [key: string]: fm.cb.resp<K> };
    trace: { [key: string]: fm.cb.trace };
  };
}
