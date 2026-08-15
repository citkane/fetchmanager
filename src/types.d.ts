/** # FetchManager types */
namespace fm {
  /**
   * # Host definition
   * Can be a string, or optionally an object including user callbacks for host level.
   */
  type host<K extends kind> =
    | ({
        host_string: string;
      } & p.handlers<K>)
    | string;

  /**
   *
   * # Request definition
   * This can be a native javascript {@link Request} instance, or {@link fm.p.req_url}
   * The latter shape is provided for passing non-standard options such as bun's `tls.rejectUnauthorized` or any other third party options.
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
   *
   * # The `fetch` method accepts a native `Request` instance or a custom definition form
   * @see {@link fm.req}
   * */
  type kind = "req" | "url";

  /**
   *
   * # Time period definitions for rate calculation
   * */
  type period = "sec" | "min" | "hr" | "day";

  /**
   *
   * # Data returned to user trace callback function for debugging
   * */
  type trace_data = {
    message?: string; // Error messaging
    paused?: number; // For how long is the queue paused in ms
    stopped?: "queue empty" | "max concurrency"; // If the queue is not running, why?
    rpp: number; // the current Request Per Period rate
    rpp_max: number; // the max allowed rpp
    rpp_period: period; // "sec" | "min" | "hr" | "day"
    concurrency: number; // number of concurrent requests
    max_concurrency: number; // max allowed concurrency
    queue: number; // length of the queue
    skip_queue: boolean; // is the current request prioritised?
    force_retry: number; // How many times to retry left? (independent of retry_cb)
    host_string: string; // host of current request
    href: string; //href of current request
  };

  /** # User defined callback functions */
  namespace cb {
    /**
     *
     * # Callback function that flags if a failed request should be retried.
     * Generally used to look for 503, 429, etc type responses
     * @param resp {@link Response}
     * @param fm_req {@link Request} || {@link p.req_url}
     * @returns `boolean` - true to retry, false to discard to error
     */
    type retry<K = kind> = (resp: Response | Error, fm_req: req<K>) => boolean;

    /**
     *
     * # Callback function that pauses the fetch queue before retrying a request.
     * The user logic within can be used to:  
     * - create request backoff behaviour
     * - determine absolute wait time from the server response
     * @param resp {@link Response}
     * @param fm_req {@link Request} || {@link p.req_url}
     * @returns `number` in ms to wait for
     */
    type wait<K = kind> = (resp: Response | Error, fm_req: req<K>) => number;

    /**
     *
     * # Callback function that processes a Response, returning the intended data.
     * @param resp {@link Response}
     * @param fm_req {@link Request} || {@link p.req_url}
     * @returns `any`
     */
    type resp<K = kind> = (resp: Response, fm_req: req<K>) => any;

    /**
     *
     * # A callback function to collect pagination results.
     * It stores an array of results which is resolved to {@link FetchManager.fetch} after pagination has completed.
     * @example
     * ```ts
     * async (resp, req, collect) => {
     *   const { next, data } = (await resp.json()) as data_type;
     *   if (!next) return; // return nullish value to stop paging
     *
     *   collect(data);
     *   const url = new URL(req.url);
     *   url.searchParams.set("offset", next.offset);
     *   return new Request(url, req); // return request to continue paging
     * }
     * ```
     *
     * ## collect
     * Usage of {@link page_collector collect} is optional. If not used, the final result defaults to:
     * 1) If `response_cb` is set - `ReturnType<response_cb>[]` else
     * 2) `Response[]`
     *
     * `collect(data[])` defaults to merging input arrays into the final returned array.
     * The default behaviour can be overidden by using `collect(data[], false)` so that the final result will be `data[][]`
     * @param resp [Response]
     * @param collect [fm.cb.page_collector] - optional data collector.
     * @param fm_req [Request | fm.p.req_url]
     * @returns The user must return, sync or async, one of:
     * + The next page request: `Request | fm.p.req_url`
     * + To stop paging: `undefined | null` or just `return`
     */
    type pager<K = kind> = (
      resp: Response,
      fm_req: req<K>,
      collect: page_collector,
    ) => p.pager_cb_rtn<K> | Promise<p.pager_cb_rtn<K>>;

    /**
     *
     * Data collector for paginated requests
     * The data is added to an Array which is returned as the final `Response` when pagination completes.
     * @param payload [any] The data to collect. Standard behaviour is to merge input arrays with the collection array to prevent `result[][]` types.
     * @param merge [boolean?] default = true. Set to false to prevent array merging
     * */
    type page_collector = (payload: any[] | any, merge = true) => void;

    /**
     *
     * # Optional callback function providing data for trace debugging.
     * @param data {@link trace_data}
     * @returns `void`
     */
    type trace = (data: trace_data) => void;
  }

  /** # User options */
  namespace opts {
    /**
     *
     * # FetchManager class constructor parameters
     * @param req_max_per_period `number` - Fetch rate limit for the period.
     * @param req_max_concurrent `number` - Limit for maximum concurrent requests.
     * @param rpp_period_def {@link period} - Time period for fetch rate.
     * @param unique_hosts `string[]` || {@link fm.host fm.host[]} - Set of hosts on which to apply limits.
     * @param options {@link fm.opts.global} - Optional user settings
     */
    type instance<K extends kind> = [
      req_max_per_period: number,
      req_max_concurrent: number,
      rpp_period_def: fm.period,
      unique_hosts: fm.host<K>[],
      options?: fm.opts.global<K>,
    ];

    /**
     *
     * # User options for the class constructor.
     * @param wait_ms `number` - ms to pause before retrying a request. Default 500
     * @param heartbeat `number` - frequency in ms to poll the request queue. Default 20
     * @param response_cb {@link fm.cb.resp}
     * @param retry_cb {@link fm.cb.retry}
     * @param wait_cb {@link fm.cb.wait}
     * @param trace_cb {@link fm.cb.trace}
     */
    type global<K extends kind> = {
      wait_ms?: number;
      heartbeat?: number;
    } & fm.p.handlers<K>;

    /**
     *
     * # User options for a {@link FetchManager.fetch} method call.
     * @param skip_queue [boolean?] Sends a request to the front of the queue
     * @param force_retry [number?] Automatically retry a failed request x number of times:
     * + `-2` will retry twice from the front of the queue.
     * + `2` will retry twice from the back of the queue.
     * @see {@link fm.cb} for optional callback function handlers
     * @param response_cb [fm.cb.resp?]
     * @param retry_cb [fm.cb.retry?]
     * @param wait_cb [fm.cb.t_out?]
     * @param trace_cb [fm.cb.trace?]
     */
    type fetch<K extends kind> = {
      skip_queue?: boolean;
      force_retry?: number;
    } & p.handlers<K>;
  }

  /** # `fetch` method overloads */
  namespace fol {
    type resp = Response;
    type knd = fm.kind;

    type fetch_req_t<K extends fm.kind> = K extends "req"
      ? Request
      : K extends "url"
        ? string
        : never;

    type fetch_pms<K extends fm.kind> = [
      req_url: Request | string,
      options_init_page?: RequestInit | fm.opts.fetch<K> | fm.cb.pager<K>,
      options_pager_cb?: fm.opts.fetch<K> | fm.cb.pager<K>,
      pager_cb?: fm.cb.pager<K>,
    ];

    type r_o<K extends fm.kind> = [
      req: fetch_req_t<K>,
      options?: fm.opts.fetch<K>,
    ];
    type r_p<K extends fm.kind> = [
      req: fetch_req_t<K>,
      pager_cb: fm.cb.pager<K>,
    ];
    type r_o_p<K extends fm.kind> = [
      req: fetch_req_t<K>,
      options: fm.opts.fetch<K>,
      pager_cb: fm.cb.pager<K>,
    ];
    type u_i = [url: string, init?: RequestInit];
    type u_o<K extends fm.kind> = [
      url: fetch_req_t<K>,
      options: fm.opts.fetch<K>,
    ];
    type u_p<K extends fm.kind> = [
      url: fetch_req_t<K>,
      pager_cb: fm.cb.pager<K>,
    ];
    type u_o_p<K extends fm.kind> = [
      url: fetch_req_t<K>,
      options: fm.opts.fetch<K>,
      pager_cb: fm.cb.pager<K>,
    ];
    type u_i_o<K extends fm.kind> = [
      url: fetch_req_t<K>,
      init: RequestInit,
      options: fm.cb.fetch_opts<K>,
    ];
    type u_i_p<K extends fm.kind> = [
      url: fetch_req_t<K>,
      init: RequestInit,
      pager_cb: fm.cb.pager<K>,
    ];
    type u_i_o_p<K extends fm.kind> = [
      url: fetch_req_t<K>,
      init: RequestInit,
      options: fm.opts.fetch<K>,
      pager_cb: fm.cb.pager<K>,
    ];
  }

  /**
   * Constructors for the callback library
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

  /** Private module types - user should not need these */
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
      host_string: string;
      force_retry: number;
      skip_queue: boolean;
      page_collector: { user: K[]; system: Response[] };
      pager_cb?: fm.cb.pager<K>;
      resolve: resolve;
      reject: reject;
    };
    type fetch_fn<K extends fm.kind> = {
      execute_fetch: Function;
      get_ctx: () => ctx<K>;
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
      hosts: { [hostname: string]: host<K> };
      reqs: limiter_reqs<K>;
      paused: limiter_paused;
      rpp: limiter_rpp;
    } & handlers<K>;
    type limiter_reqs<K extends fm.kind> = {
      queue: fetch_fn<K>[];
      concurrency: number;
      max_concurrency: number;
      incr_concurrent: () => void;
      decr_concurrent: () => void;
      stop: () => boolean;
      why_stopped: () => trace_data["stopped"];
    };
    type limiter_paused = {
      refr_state: () => boolean;
      set_state: (ms: number) => void;
      state: () => boolean;
      ms: number;
    };
    type limiter_rpp = {
      period: fm.period;
      rate: number;
      max: number;
      throttle: () => boolean;
      increment: () => void;
    };
    type host<K extends fm.kind> = {
      host_string: string;
    } & handlers<K>;
    type resolve = (value: unknown) => void;
    type reject = (reason?: any) => void;
  }
}
