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
import { hash } from "./hash.ts";

/**
 * # A zero dependency TS wrapper around native Javascript {@link fetch}
 * It provides management of:
 * - rate limitting
 * - concurrency
 * - paging
 * - retry strategy
 * - response data
 *
 * Minimal usage
 * ```ts
 * const fm = new FetchManager(300, 3, "min", ["foo.com"]);
 * const resp = await fm.fetch("https://foo.com/api/status");
 * ```
 * or use a pre-existing bucket:
 * ```ts
 * const fm = new FetchManager(bucket, ["foo.com"]);
 * const resp = await fm.fetch("https://foo.com/api/status");
 * ```
 * */
export default class FetchManager<G extends fm.kind> {
  constructor(...params: fm.opts.instance_f<G>);
  constructor(...params: fm.opts.instance_b<G>);
  constructor(...params: fm.opts.instance<G>) {
    FetchManager.class_name = this.constructor.name;
    const { set_limiter, target_groups, err } = FetchManager;
    const { args, dequeue, limiter_factory } = this;
    const default_opts = {
      wait_ms: 500,
      heartbeat: 20,
    };
    const p = args.res_constructor(default_opts, ...params);

    // The user did not provide targets, so fail fast
    if (!p.targets.length)
      err.throw("", "No targets given in constructor", params);

    const { target_keys, uid } = hash(p.targets);
    const targ_filter = args.dedupe_targets(p.targets, target_keys);
    p.targets = targ_filter.used || p.targets;
    this.target_keys = target_keys;
    this.uid = uid;

    /* ************************
     * Errors and Warnings
     * ************************ */
    if (p.bucket && p.bucket.uid !== uid)
      err.throw(
        uid,
        "The provided bucket does not match this target group.",
        p.bucket,
      );

    const clash = args.do_buckets_clash(target_keys, uid);
    if (clash && typeof clash === "string") {
      // The target definition overlaps with previous definitions
      err.throw(uid, clash, params, {
        new_targets: target_keys,
        ex_targets: target_groups,
      });
    }

    if (targ_filter.rejected?.length) {
      // Duplicate target options were found (duplicate string definitions get pruned)
      err.warn(uid, "Duplicate targets were found", targ_filter);
    }

    if (clash === true) {
      // The target group is identical to a previous instance
      // We return so that the previous instance's state is used
      const mssg =
        "Got a duplicate target group. Previous options were retained";
      err.warn(uid, mssg, { group: target_keys });
      return;
    }
    /* ************************
     * End errors and Warnings
     * ************************ */

    // Create a limiter and start polling the request queue
    const limiter = limiter_factory(p);
    set_limiter(target_keys, uid, limiter);
    limiter.heartbeat = setInterval(dequeue, limiter.heartbeat_ms);
  }

  /* The wrapped `fetch` method */
  public fetch: fm.fol.fetch = <T = Response>(...p: fm.fol.fetch_pms<G>) => {
    const { err } = FetchManager;
    const { queue_req, args, limiter, uid } = this;
    if (!limiter) return err.reject(uid, "Target group was killed");

    const req_kind = args.ident_req_kind(p);
    if (!req_kind)
      return err.reject(uid, "A Request or url string must be provided.");

    const ctx_pms = args.res_fetch_overload(req_kind, ...p);
    const url = args.url(ctx_pms.url, ctx_pms.req);
    const target_key = limiter.find_target(url);

    if (target_key instanceof Error)
      // The target wasn't found, or it exists in another instance
      return err.reject(uid, target_key.message, target_key.cause);

    const part_ctx = args.make_ctx(target_key, ctx_pms);
    return queue_req<T>(part_ctx);
  };

  /** The native fetch implementation */
  private native_fetch = (ctx: fm.p.ctx<G>) => {
    const { ctx_req, abort_timeout } = ctx;
    let { url, req_init, req } = ctx_req;
    if (ctx.aborted()) {
      // fail fast if the request was aborted
      const params = req ? ([req] as const) : ([url!, req_init] as const);
      return fetch(params[0], params[1]);
    }

    // Capture potential user signal from the given request
    const user_signal = req?.signal || req_init?.signal;
    // Create a timeout signal if set by user option
    const timeout = abort_timeout
      ? AbortSignal.timeout(abort_timeout)
      : undefined;
    // Transfer signals into the request
    const signals: AbortSignal[] = [user_signal, timeout].filter((s) => !!s);
    const init = signals.length ? { signal: AbortSignal.any(signals) } : {};
    const params = req
      ? // create a new Request - the original's body may be accessed in the callback chain.
        ([new Request(req, init)] as const)
      : ([url!, { ...(req_init || {}), ...init }] as const);
    // Execute native fetch
    return fetch(params[0], params[1]);
  };

  /**
   * # Immediately kill a group of targets and release them for re-definition
   * Queued requests will be rejected with the message "Target group was killed"
   * To cancel in-flight requests, add an Abort signal and abort from your code.
   * */
  public kill = async () => {
    const { limiters, target_groups, all_target_keys } = FetchManager;
    const { limiter, uid } = this;
    const target_keys = target_groups.get(uid) || [];
    clearInterval(limiter.heartbeat);
    limiter?.bucket.kill();
    limiter?.reqs.queue.forEach((fetch_fn) => {
      const { reject, aborted } = fetch_fn.get_ctx();
      if (aborted()) return;

      reject(Error("Target group was killed"));
    });
    if (target_keys.length)
      FetchManager.all_target_keys = all_target_keys.filter(
        (key) => !target_keys.includes(key),
      );
    limiters.delete(uid);
    target_groups.delete(uid);
    return;
  };

  /**
   * # Cleanly stop a group of targets and release them for re-definition
   * The user must stop feeding the queue, else it will not stop.
   * The queue will stop polling after all requests have been sent, but not necesarily resolved.
   * */
  public stop = async () => {
    const { limiter, kill } = this;
    return new Promise<void>((res) => poll(res));

    function poll(res: () => void) {
      return limiter.reqs.queue.length
        ? setTimeout(() => poll(res), limiter.heartbeat_ms)
        : kill().then(() => res());
    }
  };

  /** A request is added to the queue */
  private queue_req = async <T = any>(
    part_ctx: Partial<fm.p.ctx<G>>,
  ): Promise<T> => {
    const { fetch_factory, limiter } = this;
    const { skip_queue, resolve } = part_ctx;
    const retry_ctx = !!resolve ? (part_ctx as fm.p.ctx<G>) : undefined;
    if (retry_ctx) {
      const req_fn = fetch_factory(retry_ctx);
      skip_queue
        ? limiter.reqs.queue.unshift(req_fn)
        : limiter.reqs.queue.push(req_fn);
      return undefined as never;
    }

    // The user receives this promise from the `fetch` method.
    // It's `resolve` and `reject` are carried throughout the request lifecycle
    return new Promise((resolve, reject) => {
      const full_ctx = { ...part_ctx, resolve, reject } as fm.p.ctx<G>;
      const req_fn = fetch_factory(full_ctx);
      skip_queue
        ? limiter.reqs.queue.unshift(req_fn)
        : limiter.reqs.queue.push(req_fn);
    });
  };

  /** Process the next request in the queue
   * This gets called at every heartbeat **/
  private dequeue = () => {
    const { limiter, handle } = this;
    const ctx = limiter.reqs.queue[0]?.get_ctx();
    const is_paused = limiter.paused.refr_pause(ctx);
    // do not trace if the queue is empty, paused or aborted
    const should_trace = ctx && !is_paused && !ctx.aborted();
    // Should the next request be sent?
    if (limiter.reqs.is_stopped() || limiter.bucket.is_stopped() || is_paused)
      return should_trace ? handle.trace(ctx) : undefined;

    // Yes, good to go!
    // if the request was aborted before sent, so we don't process limits
    if (!ctx!.aborted()) {
      limiter.bucket.remove_token();
      limiter.bucket.inc_concurrent();
      limiter.bucket.stamp_time();
      handle.trace(ctx!);
    }
    // We execute fetch, even if aborted, to trigger the error
    const { execute_fetch } = limiter.reqs.queue.shift()!;
    execute_fetch();
  };

  /** Functionality related to fetch handling **/
  private fetch_factory = (ctx: fm.p.ctx<G>): fm.p.fetch_fn<G> => {
    const { limiter, handle, args, native_fetch } = this;
    const { err } = FetchManager;
    return {
      execute_fetch,
      get_ctx: () => ctx,
    };

    // Trigger native fetch and handle the response.
    async function execute_fetch() {
      let resp: Response;
      const was_aborted = ctx.aborted();
      try {
        resp = await native_fetch(ctx);
      } catch (_error) {
        const error = err.ensure_error(_error);
        if (was_aborted) return handle.error(ctx, error);

        limiter.bucket.dec_concurrent();
        limiter.bucket.stamp_time();
        // No response - so no rate penalty
        limiter.bucket.replace_token();
        return handle.error(ctx, error);
      }

      // Got a Response, so proceed
      limiter.bucket.dec_concurrent();
      limiter.bucket.stamp_time();
      // Response was not OK, so we handle the failed Response
      if (!resp.ok) return handle.error(ctx, resp);

      // Response was OK, so pass it through the user's pager_cb
      if (ctx.pager_cb) return handle.pager(ctx, resp, ctx.pager_cb);
      // or resolve the Response
      if (!ctx.response_cb) return ctx.resolve(resp);
      // or pass the Response through the user's response_cb
      try {
        const req = args.to_fm_req(ctx.ctx_req);
        const data = ctx.response_cb(resp, req);
        ctx.resolve(data);
      } catch (error) {
        // Error in user's callback function - reject
        ctx.reject(err.ensure_error(error));
      }
    }
  };

  /** Functionality related to the instance limiter including bucket and tokens **/
  private limiter_factory = (
    init: ReturnType<typeof this.args.res_constructor>,
  ): fm.p.limiter<G> => {
    const { handle, targets, target_keys, uid } = this;
    const { err } = FetchManager;
    const target_options = targets.to_ctx_opts(init.targets);
    const reqs = make_reqs();
    const paused = make_paused(init.options);
    const bucket = make_bucket(init.bucket);
    const heartbeat = null; // The Interval is set in the class constructor
    const {
      response_cb,
      retry_cb,
      wait_cb,
      trace_cb,
      wait_ms,
      heartbeat: heartbeat_ms,
      abort_timeout,
    } = init.options;

    return {
      wait_ms: wait_ms!,
      target_options,
      reqs,
      paused,
      bucket,
      response_cb,
      retry_cb,
      wait_cb,
      trace_cb,
      heartbeat_ms: heartbeat_ms!,
      heartbeat,
      find_target,
      abort_timeout,
    };

    // find the target key from the request url
    function find_target(url: URL) {
      const { all_target_keys, find_uid } = FetchManager;
      const { host, pathname } = url;
      const target_search = host + pathname;
      // all_target_keys is sorted longest first, so the first match will be host + pathname before host
      const target_key = all_target_keys.find((key) =>
        target_search.startsWith(key),
      );
      if (!target_key)
        return Error("No target found", { cause: { url: url.toString() } });

      if (!target_keys.includes(target_key))
        return Error("Target in another group", {
          cause: {
            url: url.toString(),
            target_group: find_uid(target_key),
          },
        });

      return target_key;
    }

    // handle and query paused state
    function make_paused(options: fm.opts.global<G>): fm.p.limiter_paused {
      const { heartbeat } = options;
      return { set_pause, refr_pause, is_paused, ms: 0 };

      function refr_pause(ctx?: fm.p.ctx<G>) {
        if (ctx?.paused) ctx.paused();
        paused.ms = paused.ms ? Math.max(0, paused.ms - heartbeat!) : 0;
        return is_paused();
      }

      function set_pause(ms: number, ctx: fm.p.ctx<G>) {
        ms = Math.max(0, ms);
        if (!ms) return;

        ms = Math.ceil(ms / heartbeat!) * heartbeat!;
        if (ms <= paused.ms) return;

        paused.ms = ms;
        handle.trace(ctx, `Fetch is paused for ${paused.ms}ms`);
      }
      function is_paused() {
        return paused.ms > 0;
      }
    }

    // access and query the request queue
    function make_reqs(): fm.p.limiter_reqs<G> {
      return {
        queue: [],
        is_stopped,
        why_stopped,
      };

      function is_stopped() {
        return !reqs.queue.length;
      }
      function why_stopped() {
        if (!is_stopped()) return bucket.why_stopped();
        return "queue empty";
      }
    }

    // create, access and query the rate bucket
    function make_bucket(init_bucket?: fm.bucket): fm.p.limiter_bucket {
      const ms = period_ms[init.period];
      const interval_ms = Math.ceil(ms / init.max_rpp);
      // drip a token into the bucket at the rate limit
      const interval = setInterval(() => add(), interval_ms);
      // use the user provided bucket, or create a new one
      const bucket: fm.bucket = init_bucket || {
        uid,
        max_rpp: init.max_rpp,
        max_concurrency: init.max_concurrency,
        period: init.period,
        tokens: init.max_rpp,
        concurrency: 0,
        time: 0,
      };
      return {
        interval,
        is_full,
        is_stopped,
        why_stopped,
        remove_token,
        replace_token,
        inc_concurrent,
        dec_concurrent,
        stamp_time,
        get,
        set,
        kill,
      };

      // Used by the static FetchManager.bucket.set method
      // Changing the rate limits is an error - only `tokens` and `concurrency` can be set.
      function set(new_bucket: fm.bucket) {
        const { tokens, concurrency, period, max_rpp, max_concurrency } =
          new_bucket;
        if (period !== init.period)
          return err.throw(uid, "periods must match", {
            have: init.period,
            got: period,
          });
        if (max_rpp !== init.max_rpp)
          return err.throw(uid, "max_rpp must match", {
            have: init.max_rpp,
            got: max_rpp,
          });
        if (max_concurrency !== init.max_concurrency)
          return err.throw(uid, "max_concurrency must match", {
            have: init.max_concurrency,
            got: max_concurrency,
          });

        bucket.tokens = tokens;
        bucket.concurrency = concurrency;
      }

      function get() {
        return bucket;
      }

      function is_full() {
        if (bucket.tokens > init.max_rpp) bucket.tokens = init.max_rpp;
        return bucket.tokens >= init.max_rpp;
      }

      function is_stopped() {
        return bucket.concurrency >= init.max_concurrency || !bucket.tokens;
      }

      function why_stopped() {
        if (bucket.concurrency >= init.max_concurrency)
          return "max concurrency";
        if (!bucket.tokens) return "rate limit exceeded";
      }

      function remove_token() {
        if (!bucket.tokens) return;
        bucket.tokens--;
      }

      function replace_token() {
        // replace the spent token. Maybe network was down, etc...
        add();
      }

      function inc_concurrent() {
        bucket.concurrency++;
      }

      function dec_concurrent() {
        if (bucket.concurrency < 0) bucket.concurrency = 0;
        if (!bucket.concurrency)
          return err.warn(uid, "No concurrency to decrease");
        bucket.concurrency--;
      }

      function add() {
        if (is_full()) return;
        bucket.tokens++;
      }

      function stamp_time() {
        bucket.time = new Date().valueOf();
      }

      function kill() {
        clearInterval(interval);
      }
    }
  };

  /** Functionality related to argument parsing **/
  private args = {
    res_constructor: (
      default_opts: fm.opts.global<G>,
      ...pms: fm.opts.instance<G>
    ) => {
      const bucket =
        typeof pms[0] === "number" ? undefined : (pms[0] as fm.bucket);
      let options =
        typeof pms[0] === "number"
          ? (pms[4] as fm.opts.global<G>) || {}
          : (pms[2] as fm.opts.global<G>) || {};
      options = { ...default_opts, ...options };
      return typeof pms[0] === "number"
        ? {
            max_rpp: pms[0] as number,
            max_concurrency: pms[1] as number,
            period: pms[2] as fm.period,
            targets: pms[3] as fm.opts.target[],
            options,
            bucket,
          }
        : {
            max_rpp: bucket!.max_rpp,
            max_concurrency: bucket!.max_concurrency,
            period: bucket!.period,
            targets: pms[1] as fm.opts.target[],
            options,
            bucket,
          };
    },

    dedupe_targets: (targs: fm.opts.target<G>[], keys: string[]) => {
      if (targs.length === keys.length) return {};

      const filtered = {
        used: {} as { [key: string]: fm.opts.target<G> },
        rejected: {} as { [key: string]: fm.opts.target<G>[] },
      };
      const { used, rejected } = filtered;
      targs.forEach((targ) => {
        const key = typeof targ === "object" ? targ.target_key : targ;
        rejected[key] ??= [];
        if (!used[key]) return (used[key] = targ);
        if (typeof targ === "object" && typeof used[key] === "string")
          return (used[key] = targ);

        if (typeof targ === "object") rejected[key]!.push(targ);
      });

      return {
        used: Object.values(used),
        rejected: Object.values(rejected).flat(),
      };
    },

    /** Identify if the user has give a Request or ("url", RequestInit) kind */
    ident_req_kind: (p: fm.fol.fetch_pms<G>) => {
      const req_or_url: string | Request = p[0];
      const req_kind: fm.kind | undefined =
        req_or_url instanceof Request && req_or_url.url.length
          ? "req"
          : typeof req_or_url === "string" && req_or_url.length
            ? "url"
            : undefined;
      return req_kind;
    },

    res_fetch_overload: (
      req_kind: fm.kind,
      ...pms: fm.fol.fetch_pms<G>
    ): fm.p.ctx_pms<G> => {
      return req_kind === "url" ? req_url_kind() : req_req_kind();

      // Resolve a "rwq" kind of request
      function req_req_kind() {
        const [req, opt_page, page] = pms.filter(is_empty_obj) as [
          Request,
          fm.opts.fetch<G> | fm.cb.pager<G> | undefined,
          fm.cb.pager<G> | undefined,
        ];
        const options = is_option(opt_page)
          ? (opt_page as fm.opts.fetch<G>)
          : undefined;
        const pager_cb = opt_page instanceof Function ? opt_page : page;

        return {
          req,
          options,
          pager_cb,
        };
      }

      // Resolve a "url" kind of request
      function req_url_kind() {
        const [url, init_opt_page, opt_page, page] = pms.filter(
          is_empty_obj,
        ) as [
          string,
          RequestInit | fm.opts.fetch<G> | fm.cb.pager<G> | undefined,
          fm.opts.fetch<G> | fm.cb.pager<G> | undefined,
          fm.cb.pager<G> | undefined,
        ];
        const req_init =
          !is_option(init_opt_page) && !(init_opt_page instanceof Function)
            ? (init_opt_page as RequestInit | undefined)
            : undefined;
        const options = [init_opt_page, opt_page].find((v) => is_option(v)) as
          fm.opts.fetch<G> | undefined;
        const pager_cb = [init_opt_page, opt_page, page].find(
          (v) => v instanceof Function,
        ) as fm.cb.pager<G> | undefined;

        return {
          url,
          req_init,
          options,
          pager_cb,
        };
      }

      function is_empty_obj(obj: any) {
        if (obj instanceof Request) return true;
        return !(
          typeof obj === "object" &&
          !Array.isArray(obj) &&
          Object.keys(obj).length === 0
        );
      }

      function is_option(v: any) {
        if (!v || v instanceof Function) return false;
        if (typeof v !== "object") return false;
        const option_keys: (keyof fm.opts.fetch<G>)[] = [
          "skip_queue",
          "force_retry",
          "abort_timeout",
          "response_cb",
          "trace_cb",
          "wait_cb",
          "retry_cb",
        ];
        return option_keys.find((key) => Object.hasOwn(v, key));
      }
    },

    // The ctx is carried through the lifecycle of a request
    make_ctx: (
      target_key: string,
      pms: fm.p.ctx_pms<G>,
    ): Partial<fm.p.ctx<G>> => {
      const { limiter } = this;
      let { options, url, req, req_init, pager_cb } = pms;
      options ??= {};
      const target = limiter.target_options[target_key]!;
      const ctx_req: fm.p.ctx_req = { url, req_init, req };
      const page_collector = { user: [] as any[], system: [] as Response[] };
      const handlers = cascade_handlers();
      let skip_queue = options.skip_queue || false;
      if (options.force_retry && options.force_retry < 0) skip_queue = true;

      const abort_timeout =
        options.abort_timeout || target.abort_timeout || limiter.abort_timeout;
      return {
        ctx_req,
        target_key,
        page_collector,
        ...options,
        ...handlers,
        skip_queue,
        abort_timeout,
        aborted,
      };

      // Merges the user handlers into the request context in order of priority:
      // 1) defined in `fetch` method
      // 2) defined in constructor target options
      // 3) defined in contructor global options
      function cascade_handlers() {
        const handler_keys: (keyof fm.p.handlers<G>)[] = [
          "response_cb",
          "retry_cb",
          "wait_cb",
          "trace_cb",
        ];
        const handlers = {
          pager_cb,
        } as fm.p.handlers<G> & { pager_cb?: fm.cb.pager<G> };

        return [limiter, target, options].reduce((handlers, opts) => {
          handler_keys.forEach((key) => {
            if (opts && opts[key]) handlers[key] = opts[key] as any;
          });
          return handlers;
        }, handlers);
      }

      function aborted() {
        return (req || req_init)?.signal?.aborted || false;
      }
    },

    do_buckets_clash: (new_targs: string[], uid: string) => {
      const { limiters, all_target_keys } = FetchManager;
      if (limiters.has(uid)) return true;

      const clashes: string[] = [];
      new_targs.reduce((clashes, new_targ) => {
        const clash = all_target_keys.find((ex_targ) => ex_targ === new_targ);
        if (!clash) return clashes;

        clashes.push(clash);
        return clashes;
      }, clashes);

      return clashes.length
        ? `Targets already defined in other groups: [ ${clashes.join(", ")} ]`
        : false;
    },

    // Normalise request definition in context to {req?: Request, url? string, request_init?: RequestInit}
    to_ctx_req: (fm_req: fm.req<G>): fm.p.ctx_req => {
      if (fm_req instanceof Request) return { req: fm_req };
      return fm_req;
    },

    // Convert context request back to given request shape.
    to_fm_req: (ctx_req: fm.p.ctx_req): fm.req<G> => {
      const { req, url, req_init } = ctx_req;
      return req ? (req as fm.req<G>) : ({ url, req_init } as fm.req<G>);
    },

    url: (url?: string, req?: Request) => {
      const url_string = req ? req.url : url!;
      return new URL(url_string);
    },
  };

  /** Functionality related to target parsing and shaping **/
  private targets = {
    make_trace_data: (ctx: fm.p.ctx<G>, mssg?: string): fm.trace_data => {
      const { limiter, args } = this;
      const { force_retry, target_key, skip_queue, ctx_req } = ctx;
      const href = args.url(ctx_req.url, ctx_req.req).href;
      const { max_concurrency, concurrency, max_rpp, tokens, period } =
        limiter.bucket.get();
      return {
        tokens,
        message: mssg || limiter.reqs.why_stopped(),
        paused: limiter.paused.ms,
        concurrency,
        max_concurrency,
        max_rpp,
        period,
        queue: limiter.reqs.queue.length,
        force_retry,
        skip_queue,
        target_key,
        href,
        time: new Date().valueOf(),
      };
    },

    // Normalise all given targets into {target_key: string, ...} shape
    to_ctx_opts: (targs: fm.opts.target<G>[]) => {
      const keyed_targs = {} as {
        [target_key: string]: fm.opts.target_options<G>;
      };
      return targs.reduce(reducer, keyed_targs);

      function reducer(
        keyed_targs: { [target_key: string]: fm.opts.target_options<G> },
        target: fm.opts.target<G>,
      ) {
        const is_object = typeof target === "object";
        const targ_object = is_object ? target : { target_key: target };
        const { target_key } = targ_object;
        keyed_targs[target_key] = targ_object;
        return keyed_targs;
      }
    },
  };

  /** Handle a request lifecycle including user callbacks **/
  private handle = {
    // Route a failed request, either an Error or no Response.ok
    error: (ctx: fm.p.ctx<G>, resp: Response | Error) => {
      const { handle, args } = this;
      const href = args.url(ctx.ctx_req.url, ctx.ctx_req.req).href;
      const mssg =
        resp instanceof Response
          ? `${resp.status} ${resp.statusText} for ${href}.`
          : `Fetch errored before response for ${href}.`;
      handle.trace(ctx, mssg);
      // Retry the request if needed
      if (handle.should_retry(ctx, resp)) return handle.retry(ctx, resp);

      ctx.reject(resp);
    },

    // Check if a failed request should be retried
    should_retry: (ctx: fm.p.ctx<G>, resp: Response | Error) => {
      const { args } = this;
      const { err } = FetchManager;
      const req = args.to_fm_req(ctx.ctx_req);
      // force_retry overrides retry_cb
      if (ctx.force_retry) return true;
      if (!ctx.retry_cb) return false;

      // Pass the response through the user's retry_cb
      try {
        // Clone the Response in case it's body needs to be read again
        const resp_c = resp instanceof Response ? resp.clone() : resp;
        return ctx.retry_cb(resp_c, req);
      } catch (error) {
        ctx.reject(err.ensure_error(error));
        return false;
      }
    },

    //Handle a request retry
    retry: (ctx: fm.p.ctx<G>, resp: Response | Error) => {
      const { handle, queue_req } = this;
      if (ctx.force_retry) {
        ctx.skip_queue = ctx.force_retry > 0 ? false : true;
        ctx.force_retry > 0 ? ctx.force_retry-- : ctx.force_retry++;
      }
      handle.pause(ctx, resp);
      queue_req(ctx);
    },

    // Handle queue pausing
    pause: async (ctx: fm.p.ctx<G>, resp: Response | Error) => {
      const { limiter, args } = this;
      const { err } = FetchManager;
      // The user's wait_cb takes precedence over the default wait_ms
      let ms = ctx.wait_cb ? await try_wait_cb() : limiter.wait_ms;
      if (
        ctx.force_retry &&
        ctx.force_retry > 0 &&
        limiter.reqs.queue.length &&
        !ctx.wait_cb
      ) {
        // The request is retrying from the back of a non-empty queue.
        // We do not want to pause the queue in front of it.
        // We want to honor the remainder of the paused time once it reaches the front.
        // If the user has set wait_cb, this block is negated, and the queue is paused immediately
        ctx.paused = () => {
          clearInterval(pause);
          delete ctx.paused;
          limiter.paused.set_pause(ms, ctx);
        };
        const pause = setInterval(() => {
          if (ms <= 0) return clearInterval(pause);
          ms = Math.max(0, ms - limiter.heartbeat_ms);
        }, limiter.heartbeat_ms);

        return 0;
      }
      return limiter.paused.set_pause(ms, ctx);

      // execute the user's wait_cb
      async function try_wait_cb() {
        try {
          return ctx.wait_cb!(resp, args.to_fm_req(ctx.ctx_req));
        } catch (error) {
          ctx.reject(err.ensure_error(error));
          return 0;
        }
      }
    },

    // Handle the user's trace_cb
    trace: (ctx: fm.p.ctx<G>, mssg?: string) => {
      const { targets } = this;
      const { err } = FetchManager;
      if (!ctx.trace_cb) return;

      const data = targets.make_trace_data(ctx, mssg);
      try {
        ctx.trace_cb(data);
      } catch (error) {
        ctx.reject(err.ensure_error(error));
      }
    },

    // Handle the user's pager_cb
    pager: async (
      ctx: fm.p.ctx<G>,
      resp: Response,
      pager_cb: fm.cb.pager<G>,
    ) => {
      const { queue_req, args } = this;
      const { err } = FetchManager;
      const req = args.to_fm_req(ctx.ctx_req);
      let new_req: fm.p.pager_cb_rtn<G>;
      try {
        // Clone the response in case it's body needs to be read again
        new_req = await pager_cb(resp.clone(), req, user_collector);
      } catch (error) {
        return ctx.reject(err.ensure_error(error));
      }

      ctx.page_collector.system.push(resp);
      if (new_req) {
        ctx.skip_queue = true; // Always page from the front of the queue
        ctx.ctx_req = args.to_ctx_req(new_req);
        return queue_req(ctx);
      }
      if (ctx.page_collector.user.length)
        // The user has used the `collect` function. Resolve that data
        return ctx.resolve(ctx.page_collector.user);

      // There is no user response_cb, so return an Array of Responses
      if (!ctx.response_cb) return ctx.resolve(ctx.page_collector.system);

      // User has defined response_cb, so resolve all returned values into an array.
      try {
        const resp_array = await Promise.all(
          ctx.page_collector.system.map((res) => ctx.response_cb!(res, req)),
        );
        ctx.resolve(resp_array);
      } catch (error) {
        ctx.reject(err.ensure_error(error));
      }

      // Flatten arrays of arrays, except if `merge` === false
      function user_collector(payload: any[] | any, merge = true) {
        if (Array.isArray(payload) && merge) {
          payload.forEach((val) => ctx.page_collector.user.push(val));
          return;
        }

        ctx.page_collector.user.push(payload);
      }
    },
  };

  public uid: string;
  private target_keys: string[];
  private get limiter() {
    return FetchManager.limiters.get(this.uid)! as fm.p.limiter<G>;
  }

  /* **********************************************
   * Start static members
   * ********************************************** */

  /**
   * # Static access to all buckets
   * Buckets can be accessed by the group uid, or found by a target key within the group
   * */
  public static bucket = {
    /**
     * # Get an instance bucket
     * @param key_or_uid [string] The instance uid or a target key within the instance
     * @returns [fm.bucket]
     * */
    get: (key_or_uid: string) => {
      const { find_uid, limiters } = this;
      const uid = limiters.has(key_or_uid) ? key_or_uid : find_uid(key_or_uid);
      return uid ? limiters.get(uid)!.bucket.get() : undefined;
    },

    /**
     * # Update an instance bucket
     * @param key_or_uid [string] The instance uid or a target key within the instance
     * @param bucket [fm.bucket] The bucket uid and limit settings must match the existing bucket
     * */
    set: (key_or_uid: string, bucket: fm.bucket) => {
      const { find_uid, err, limiters, target_groups } = this;
      const uid = limiters.has(key_or_uid) ? key_or_uid : find_uid(key_or_uid);
      if (!uid) {
        return err.throw("", "No target group found", key_or_uid, {
          groups: Object.fromEntries(target_groups.entries()),
        });
      }

      const limiter = limiters.get(uid)!;
      limiter.bucket.set(bucket);
    },
  };

  /**
   * # Get a static map of all buckets
   * @returns `{[uid: string]: fm.bucket}` - A map of buckets keyed by uid.
   * */
  public static get buckets(): { [uid: string]: fm.bucket } {
    const { limiters } = this;
    const entries = limiters
      .keys()
      .map((uid) => [uid, limiters.get(uid)!.bucket.get()]);
    return Object.fromEntries(entries);
  }

  /**
   * # Get a static map of all targets
   * @returns `{[uid: string]: target_key[]}` - A map of target groups keyed by uid.
   * */
  public static get targets() {
    return Object.fromEntries(this.target_groups.entries());
  }

  /**
   * # Converts a target group into uid and keys
   * @param targets [Array<fm.target>] the target group
   * @returns [{uid: string, target_keys: Array<string>}]
   * */
  public static hash = hash;

  /** Error messaging handling **/
  private static err = {
    message: (uid: string, mssg: string) => {
      if (uid.length) uid = ` [${uid}]`;
      return `[${this.class_name}]${uid} ${mssg}`;
    },

    reject: (uid: string, mssg: unknown, ...reasons: any[]) => {
      if (typeof mssg !== "string")
        return Promise.reject(this.err.ensure_error(mssg));

      mssg = this.err.message(uid, mssg);
      const err = Error(mssg as string, { cause: reasons });
      return Promise.reject(err);
    },

    throw: (uid: string, mssg: string, ...details: any[]) => {
      throw Error(this.err.message(uid, mssg), { cause: details });
    },

    warn: (uid: string, mssg: string, ...data: any[]) => {
      mssg = this.err.message(uid, mssg);
      console.warn(mssg, ...data);
    },

    ensure_error: (err: unknown) => {
      try {
        return err instanceof Error
          ? err
          : typeof err === "string"
            ? Error(err)
            : typeof err === "number"
              ? Error(String(err))
              : typeof err === "object" &&
                  Object.hasOwn(err!, "toString") &&
                  err!.toString instanceof Function
                ? Error(err!.toString())
                : typeof err === "object"
                  ? Error(JSON.stringify(err))
                  : Error("unknown error");
      } catch (_err) {
        return Error("unknown error");
      }
    },
  };

  /** Find a group uid from a member target key **/
  private static find_uid = (target_key: string) => {
    const { target_groups } = this;
    const entry = target_groups
      .entries()
      .find(([_uid, targets]) => targets.includes(target_key));
    return entry ? entry[0] : undefined;
  };

  /** Set a limiter into the static limiter map **/
  private static set_limiter = (
    target_keys: string[],
    hash_id: string,
    limiter: fm.p.limiter<fm.kind>,
  ) => {
    const { limiters, target_groups, all_target_keys } = this;
    limiters.set(hash_id, limiter);
    target_groups.set(hash_id, target_keys);
    // We sort all target keys to enable finding keys with pathnames first (longest first)
    this.all_target_keys = [...all_target_keys, ...target_keys].sort(
      (a, b) => b.length - a.length,
    );
  };

  private static class_name: string;
  private static all_target_keys: string[] = [];
  private static target_groups = new Map<string, string[]>();
  private static limiters = new Map<string, fm.p.limiter<fm.kind>>();
}

const period_ms = (() => {
  const sec = 1000;
  const min = sec * 60;
  const hr = min * 60;
  const day = hr * 24;
  return { sec, min, hr, day };
})();
