// src/hash.ts
function hash(targets) {
  const target_keys = parse_targets(targets);
  const str = target_keys.join("");
  let h1 = 0;
  let i = 0;
  const len = str.length;
  const remainder = len & 3;
  const bytes = len - remainder;
  const c1 = 3432918353;
  const c2 = 461845907;
  while (i < bytes) {
    let k12 = str.charCodeAt(i) & 255 | (str.charCodeAt(i + 1) & 255) << 8 | (str.charCodeAt(i + 2) & 255) << 16 | (str.charCodeAt(i + 3) & 255) << 24;
    k12 = Math.imul(k12, c1);
    k12 = k12 << 15 | k12 >>> 17;
    k12 = Math.imul(k12, c2);
    h1 ^= k12;
    h1 = h1 << 13 | h1 >>> 19;
    h1 = Math.imul(h1, 5) + 3864292196;
    i += 4;
  }
  let k1 = 0;
  if (remainder === 3)
    k1 ^= (str.charCodeAt(i + 2) & 255) << 16;
  if (remainder >= 2)
    k1 ^= (str.charCodeAt(i + 1) & 255) << 8;
  if (remainder >= 1) {
    k1 ^= str.charCodeAt(i) & 255;
    k1 = Math.imul(k1, c1);
    k1 = k1 << 15 | k1 >>> 17;
    k1 = Math.imul(k1, c2);
    h1 ^= k1;
  }
  h1 ^= len;
  h1 ^= h1 >>> 16;
  h1 = Math.imul(h1, 2246822507);
  h1 ^= h1 >>> 13;
  h1 = Math.imul(h1, 3266489909);
  h1 ^= h1 >>> 16;
  const uid = (h1 >>> 0).toString(16).padStart(8, "0");
  return { target_keys, uid };
}
function parse_targets(targets) {
  const targ_strings = targets.map((targ) => typeof targ === "string" ? targ : targ.target_key).map((targ) => {
    targ = targ.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
    const { host, pathname } = new URL("any://" + targ);
    return pathname ? host + pathname : host;
  });
  return [...new Set(targ_strings)].sort((a, b) => b.length - a.length);
}

// src/FetchManager.ts
class FetchManager {
  constructor(...params) {
    FetchManager.class_name = this.constructor.name;
    const { set_limiter, target_groups, err } = FetchManager;
    const { args, dequeue, limiter_factory } = this;
    const default_opts = {
      wait_ms: 500,
      heartbeat: 20
    };
    const p = args.res_constructor(default_opts, ...params);
    if (!p.targets.length)
      err.throw("", "No targets given in constructor", params);
    const { target_keys, uid } = hash(p.targets);
    const targ_filter = args.dedupe_targets(p.targets, target_keys);
    p.targets = targ_filter.used || p.targets;
    this.target_keys = target_keys;
    this.uid = uid;
    if (p.bucket && p.bucket.uid !== uid)
      err.throw(uid, "The provided bucket does not match this target group.", p.bucket);
    const clash = args.do_buckets_clash(target_keys, uid);
    if (clash && typeof clash === "string") {
      err.throw(uid, clash, params, {
        new_targets: target_keys,
        ex_targets: target_groups
      });
    }
    if (targ_filter.rejected?.length) {
      err.warn(uid, "Duplicate targets were found", targ_filter);
    }
    if (clash === true) {
      const mssg = "Got a duplicate target group. Previous options were retained";
      err.warn(uid, mssg, { group: target_keys });
      return;
    }
    const limiter = limiter_factory(p);
    set_limiter(target_keys, uid, limiter);
    limiter.heartbeat = setInterval(dequeue, limiter.heartbeat_ms);
  }
  fetch = (...p) => {
    const { err } = FetchManager;
    const { queue_req, args, limiter, uid } = this;
    if (!limiter)
      return err.reject(uid, "Target group was killed");
    const req_kind = args.ident_req_kind(p);
    if (!req_kind)
      return err.reject(uid, "A Request or url string must be provided.");
    const ctx_pms = args.res_fetch_overload(req_kind, ...p);
    const url = args.url(ctx_pms.url, ctx_pms.req);
    const target_key = limiter.find_target(url);
    if (target_key instanceof Error)
      return err.reject(uid, target_key.message, target_key.cause);
    const part_ctx = args.make_ctx(target_key, ctx_pms);
    return queue_req(part_ctx);
  };
  native_fetch = (ctx) => {
    const { ctx_req, abort_timeout } = ctx;
    let { url, req_init, req } = ctx_req;
    const user_signal = req?.signal || req_init?.signal;
    const timeout = abort_timeout ? AbortSignal.timeout(abort_timeout) : undefined;
    const signals = [user_signal, timeout].filter((s) => !!s);
    const init = signals.length ? { signal: AbortSignal.any(signals) } : {};
    const params = req ? [new Request(req, init)] : [url, { ...req_init || {}, ...init }];
    return fetch(params[0], params[1]);
  };
  kill = async () => {
    const { limiters, target_groups, all_target_keys } = FetchManager;
    const { limiter, uid } = this;
    const target_keys = target_groups.get(uid) || [];
    clearInterval(limiter.heartbeat);
    limiter?.bucket.kill();
    limiter?.reqs.queue.forEach((req) => {
      const { reject } = req.get_ctx();
      reject(Error("Target group was killed"));
    });
    if (target_keys.length)
      FetchManager.all_target_keys = all_target_keys.filter((key) => !target_keys.includes(key));
    limiters.delete(uid);
    target_groups.delete(uid);
    return;
  };
  stop = async () => {
    const { limiter, kill } = this;
    return new Promise((res) => poll(res));
    function poll(res) {
      return limiter.reqs.queue.length ? setTimeout(() => poll(res), limiter.heartbeat_ms) : kill().then(() => res());
    }
  };
  queue_req = async (part_ctx) => {
    const { fetch_factory, limiter } = this;
    const { skip_queue, resolve } = part_ctx;
    const retry_ctx = resolve ? part_ctx : undefined;
    if (retry_ctx) {
      const req_fn = fetch_factory(retry_ctx);
      skip_queue ? limiter.reqs.queue.unshift(req_fn) : limiter.reqs.queue.push(req_fn);
      return;
    }
    return new Promise((resolve2, reject) => {
      const full_ctx = { ...part_ctx, resolve: resolve2, reject };
      const req_fn = fetch_factory(full_ctx);
      skip_queue ? limiter.reqs.queue.unshift(req_fn) : limiter.reqs.queue.push(req_fn);
    });
  };
  dequeue = () => {
    const { limiter, handle } = this;
    const ctx = limiter.reqs.queue[0]?.get_ctx();
    const is_paused = limiter.paused.refr_pause(ctx);
    if (limiter.reqs.is_stopped() || limiter.bucket.is_stopped() || is_paused)
      return ctx && !is_paused ? handle.trace(ctx) : undefined;
    limiter.bucket.remove_token();
    limiter.bucket.inc_concurrent();
    limiter.bucket.stamp_time();
    handle.trace(ctx);
    const { execute_fetch } = limiter.reqs.queue.shift();
    execute_fetch();
  };
  fetch_factory = (ctx) => {
    const { limiter, handle, args, native_fetch } = this;
    const { err } = FetchManager;
    return {
      execute_fetch,
      get_ctx: () => ctx
    };
    async function execute_fetch() {
      let resp;
      try {
        resp = await native_fetch(ctx);
      } catch (_error) {
        const error = err.ensure_error(_error);
        limiter.bucket.dec_concurrent();
        limiter.bucket.stamp_time();
        limiter.bucket.replace_token(error);
        return handle.error(ctx, error);
      }
      limiter.bucket.dec_concurrent();
      limiter.bucket.stamp_time();
      if (!resp.ok)
        return handle.error(ctx, resp);
      if (ctx.pager_cb)
        return handle.pager(ctx, resp, ctx.pager_cb);
      if (!ctx.response_cb)
        return ctx.resolve(resp);
      try {
        const req = args.to_fm_req(ctx.ctx_req);
        const data = ctx.response_cb(resp, req);
        ctx.resolve(data);
      } catch (error) {
        ctx.reject(err.ensure_error(error));
      }
    }
  };
  limiter_factory = (init) => {
    const { handle, targets, target_keys, uid } = this;
    const { err } = FetchManager;
    const target_options = targets.to_ctx_opts(init.targets);
    const reqs = make_reqs();
    const paused = make_paused(init.options);
    const bucket = make_bucket(init.bucket);
    const heartbeat = null;
    const {
      response_cb,
      retry_cb,
      wait_cb,
      trace_cb,
      wait_ms,
      heartbeat: heartbeat_ms,
      abort_timeout
    } = init.options;
    return {
      wait_ms,
      target_options,
      reqs,
      paused,
      bucket,
      response_cb,
      retry_cb,
      wait_cb,
      trace_cb,
      heartbeat_ms,
      heartbeat,
      find_target,
      abort_timeout
    };
    function find_target(url) {
      const { all_target_keys, find_uid } = FetchManager;
      const { host, pathname } = url;
      const target_search = host + pathname;
      const target_key = all_target_keys.find((key) => target_search.startsWith(key));
      if (!target_key)
        return Error("No target found", { cause: { url: url.toString() } });
      if (!target_keys.includes(target_key))
        return Error("Target in another group", {
          cause: {
            url: url.toString(),
            target_group: find_uid(target_key)
          }
        });
      return target_key;
    }
    function make_paused(options) {
      const { heartbeat: heartbeat2 } = options;
      return { set_pause, refr_pause, is_paused, ms: 0 };
      function refr_pause(ctx) {
        if (ctx?.paused)
          ctx.paused();
        paused.ms = paused.ms ? Math.max(0, paused.ms - heartbeat2) : 0;
        return is_paused();
      }
      function set_pause(ms, ctx) {
        ms = Math.max(0, ms);
        if (!ms)
          return;
        ms = Math.ceil(ms / heartbeat2) * heartbeat2;
        if (ms <= paused.ms)
          return;
        paused.ms = ms;
        handle.trace(ctx, `Fetch is paused for ${paused.ms}ms`);
      }
      function is_paused() {
        return paused.ms > 0;
      }
    }
    function make_reqs() {
      return {
        queue: [],
        is_stopped,
        why_stopped
      };
      function is_stopped() {
        return !reqs.queue.length;
      }
      function why_stopped() {
        if (!is_stopped())
          return bucket.why_stopped();
        return "queue empty";
      }
    }
    function make_bucket(init_bucket) {
      const ms = period_ms[init.period];
      const interval_ms = Math.ceil(ms / init.max_rpp);
      const interval = setInterval(() => add(), interval_ms);
      const bucket2 = init_bucket || {
        uid,
        max_rpp: init.max_rpp,
        max_concurrency: init.max_concurrency,
        period: init.period,
        tokens: init.max_rpp,
        concurrency: 0,
        time: 0
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
        kill
      };
      function set(new_bucket) {
        const { tokens, concurrency, period, max_rpp, max_concurrency } = new_bucket;
        if (period !== init.period)
          return err.throw(uid, "periods must match", {
            have: init.period,
            got: period
          });
        if (max_rpp !== init.max_rpp)
          return err.throw(uid, "max_rpp must match", {
            have: init.max_rpp,
            got: max_rpp
          });
        if (max_concurrency !== init.max_concurrency)
          return err.throw(uid, "max_concurrency must match", {
            have: init.max_concurrency,
            got: max_concurrency
          });
        bucket2.tokens = tokens;
        bucket2.concurrency = concurrency;
      }
      function get() {
        return bucket2;
      }
      function is_full() {
        if (bucket2.tokens > init.max_rpp)
          bucket2.tokens = init.max_rpp;
        return bucket2.tokens >= init.max_rpp;
      }
      function is_stopped() {
        return bucket2.concurrency >= init.max_concurrency || !bucket2.tokens;
      }
      function why_stopped() {
        if (bucket2.concurrency >= init.max_concurrency)
          return "max concurrency";
        if (!bucket2.tokens)
          return "rate limit exceeded";
      }
      function remove_token() {
        if (!bucket2.tokens)
          return;
        bucket2.tokens--;
      }
      function replace_token(err2) {
        if (err2.name === "TimeoutError" || err2.name === "AbortError")
          return;
        add();
      }
      function inc_concurrent() {
        bucket2.concurrency++;
      }
      function dec_concurrent() {
        if (bucket2.concurrency < 0)
          bucket2.concurrency = 0;
        if (!bucket2.concurrency)
          return err.warn(uid, "No concurrency to decrease");
        bucket2.concurrency--;
      }
      function add() {
        if (is_full())
          return;
        bucket2.tokens++;
      }
      function stamp_time() {
        bucket2.time = new Date().valueOf();
      }
      function kill() {
        clearInterval(interval);
      }
    }
  };
  args = {
    res_constructor: (default_opts, ...pms) => {
      const bucket = typeof pms[0] === "number" ? undefined : pms[0];
      let options = typeof pms[0] === "number" ? pms[4] || {} : pms[2] || {};
      options = { ...default_opts, ...options };
      return typeof pms[0] === "number" ? {
        max_rpp: pms[0],
        max_concurrency: pms[1],
        period: pms[2],
        targets: pms[3],
        options,
        bucket
      } : {
        max_rpp: bucket.max_rpp,
        max_concurrency: bucket.max_concurrency,
        period: bucket.period,
        targets: pms[1],
        options,
        bucket
      };
    },
    dedupe_targets: (targs, keys) => {
      if (targs.length === keys.length)
        return {};
      const filtered = {
        used: {},
        rejected: {}
      };
      const { used, rejected } = filtered;
      targs.forEach((targ) => {
        const key = typeof targ === "object" ? targ.target_key : targ;
        rejected[key] ??= [];
        if (!used[key])
          return used[key] = targ;
        if (typeof targ === "object" && typeof used[key] === "string")
          return used[key] = targ;
        if (typeof targ === "object")
          rejected[key].push(targ);
      });
      return {
        used: Object.values(used),
        rejected: Object.values(rejected).flat()
      };
    },
    ident_req_kind: (p) => {
      const req_or_url = p[0];
      const req_kind = req_or_url instanceof Request && req_or_url.url.length ? "req" : typeof req_or_url === "string" && req_or_url.length ? "url" : undefined;
      return req_kind;
    },
    res_fetch_overload: (req_kind, ...pms) => {
      return req_kind === "url" ? req_url_kind() : req_req_kind();
      function req_req_kind() {
        const [req, opt_page, page] = pms.filter(is_empty_obj);
        const options = is_option(opt_page) ? opt_page : undefined;
        const pager_cb = opt_page instanceof Function ? opt_page : page;
        return {
          req,
          options,
          pager_cb
        };
      }
      function req_url_kind() {
        const [url, init_opt_page, opt_page, page] = pms.filter(is_empty_obj);
        const req_init = !is_option(init_opt_page) && !(init_opt_page instanceof Function) ? init_opt_page : undefined;
        const options = [init_opt_page, opt_page].find((v) => is_option(v));
        const pager_cb = [init_opt_page, opt_page, page].find((v) => v instanceof Function);
        return {
          url,
          req_init,
          options,
          pager_cb
        };
      }
      function is_empty_obj(obj) {
        if (obj instanceof Request)
          return true;
        return !(typeof obj === "object" && !Array.isArray(obj) && Object.keys(obj).length === 0);
      }
      function is_option(v) {
        if (!v || v instanceof Function)
          return false;
        if (typeof v !== "object")
          return false;
        const option_keys = [
          "skip_queue",
          "force_retry",
          "abort_timeout",
          "response_cb",
          "trace_cb",
          "wait_cb",
          "retry_cb"
        ];
        return option_keys.find((key) => Object.hasOwn(v, key));
      }
    },
    make_ctx: (target_key, pms) => {
      const { limiter } = this;
      let { options, url, req, req_init, pager_cb } = pms;
      options ??= {};
      const target = limiter.target_options[target_key];
      const ctx_req = { url, req_init, req };
      const page_collector = { user: [], system: [] };
      const handlers = cascade_handlers();
      let skip_queue = options.skip_queue || false;
      if (options.force_retry && options.force_retry < 0)
        skip_queue = true;
      const abort_timeout = options.abort_timeout || target.abort_timeout || limiter.abort_timeout;
      return {
        ctx_req,
        target_key,
        page_collector,
        ...options,
        ...handlers,
        skip_queue,
        abort_timeout
      };
      function cascade_handlers() {
        const handler_keys = [
          "response_cb",
          "retry_cb",
          "wait_cb",
          "trace_cb"
        ];
        const handlers2 = {
          pager_cb
        };
        return [limiter, target, options].reduce((handlers3, opts) => {
          handler_keys.forEach((key) => {
            if (opts && opts[key])
              handlers3[key] = opts[key];
          });
          return handlers3;
        }, handlers2);
      }
    },
    do_buckets_clash: (new_targs, uid) => {
      const { limiters, all_target_keys } = FetchManager;
      if (limiters.has(uid))
        return true;
      const clashes = [];
      new_targs.reduce((clashes2, new_targ) => {
        const clash = all_target_keys.find((ex_targ) => ex_targ === new_targ);
        if (!clash)
          return clashes2;
        clashes2.push(clash);
        return clashes2;
      }, clashes);
      return clashes.length ? `Targets already defined in other groups: [ ${clashes.join(", ")} ]` : false;
    },
    to_ctx_req: (fm_req) => {
      if (fm_req instanceof Request)
        return { req: fm_req };
      return fm_req;
    },
    to_fm_req: (ctx_req) => {
      const { req, url, req_init } = ctx_req;
      return req ? req : { url, req_init };
    },
    url: (url, req) => {
      const url_string = req ? req.url : url;
      return new URL(url_string);
    }
  };
  targets = {
    make_trace_data: (ctx, mssg) => {
      const { limiter, args } = this;
      const { force_retry, target_key, skip_queue, ctx_req } = ctx;
      const href = args.url(ctx_req.url, ctx_req.req).href;
      const { max_concurrency, concurrency, max_rpp, tokens, period } = limiter.bucket.get();
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
        time: new Date().valueOf()
      };
    },
    to_ctx_opts: (targs) => {
      const keyed_targs = {};
      return targs.reduce(reducer, keyed_targs);
      function reducer(keyed_targs2, target) {
        const is_object = typeof target === "object";
        const targ_object = is_object ? target : { target_key: target };
        const { target_key } = targ_object;
        keyed_targs2[target_key] = targ_object;
        return keyed_targs2;
      }
    }
  };
  handle = {
    error: (ctx, resp) => {
      const { handle, args } = this;
      const href = args.url(ctx.ctx_req.url, ctx.ctx_req.req).href;
      const mssg = resp instanceof Response ? `${resp.status} ${resp.statusText} for ${href}.` : `Fetch errored before response for ${href}.`;
      handle.trace(ctx, mssg);
      if (handle.should_retry(ctx, resp))
        return handle.retry(ctx, resp);
      ctx.reject(resp);
    },
    should_retry: (ctx, resp) => {
      const { args } = this;
      const { err } = FetchManager;
      const req = args.to_fm_req(ctx.ctx_req);
      if (ctx.force_retry)
        return true;
      if (!ctx.retry_cb)
        return false;
      try {
        const resp_c = resp instanceof Response ? resp.clone() : resp;
        return ctx.retry_cb(resp_c, req);
      } catch (error) {
        ctx.reject(err.ensure_error(error));
        return false;
      }
    },
    retry: (ctx, resp) => {
      const { handle, queue_req } = this;
      if (ctx.force_retry) {
        ctx.skip_queue = ctx.force_retry > 0 ? false : true;
        ctx.force_retry > 0 ? ctx.force_retry-- : ctx.force_retry++;
      }
      handle.pause(ctx, resp);
      queue_req(ctx);
    },
    pause: async (ctx, resp) => {
      const { limiter, args } = this;
      const { err } = FetchManager;
      let ms = ctx.wait_cb ? await try_wait_cb() : limiter.wait_ms;
      if (ctx.force_retry && ctx.force_retry > 0 && limiter.reqs.queue.length && !ctx.wait_cb) {
        ctx.paused = () => {
          clearInterval(pause);
          delete ctx.paused;
          limiter.paused.set_pause(ms, ctx);
        };
        const pause = setInterval(() => {
          if (ms <= 0)
            return clearInterval(pause);
          ms = Math.max(0, ms - limiter.heartbeat_ms);
        }, limiter.heartbeat_ms);
        return 0;
      }
      return limiter.paused.set_pause(ms, ctx);
      async function try_wait_cb() {
        try {
          return ctx.wait_cb(resp, args.to_fm_req(ctx.ctx_req));
        } catch (error) {
          ctx.reject(err.ensure_error(error));
          return 0;
        }
      }
    },
    trace: (ctx, mssg) => {
      const { targets } = this;
      if (!ctx.trace_cb)
        return;
      const data = targets.make_trace_data(ctx, mssg);
      ctx.trace_cb(data);
    },
    pager: async (ctx, resp, pager_cb) => {
      const { queue_req, args } = this;
      const { err } = FetchManager;
      const req = args.to_fm_req(ctx.ctx_req);
      let new_req;
      try {
        new_req = await pager_cb(resp.clone(), req, user_collector);
      } catch (error) {
        return ctx.reject(err.ensure_error(error));
      }
      ctx.page_collector.system.push(resp);
      if (new_req) {
        ctx.skip_queue = true;
        ctx.ctx_req = args.to_ctx_req(new_req);
        return queue_req(ctx);
      }
      if (ctx.page_collector.user.length)
        return ctx.resolve(ctx.page_collector.user);
      if (!ctx.response_cb)
        return ctx.resolve(ctx.page_collector.system);
      try {
        const resp_array = await Promise.all(ctx.page_collector.system.map((res) => ctx.response_cb(res, req)));
        ctx.resolve(resp_array);
      } catch (error) {
        ctx.reject(err.ensure_error(error));
      }
      function user_collector(payload, merge = true) {
        if (Array.isArray(payload) && merge) {
          payload.forEach((val) => ctx.page_collector.user.push(val));
          return;
        }
        ctx.page_collector.user.push(payload);
      }
    }
  };
  uid;
  target_keys;
  get limiter() {
    return FetchManager.limiters.get(this.uid);
  }
  static bucket = {
    get: (key_or_uid) => {
      const { find_uid, limiters } = this;
      const uid = limiters.has(key_or_uid) ? key_or_uid : find_uid(key_or_uid);
      return uid ? limiters.get(uid).bucket.get() : undefined;
    },
    set: (key_or_uid, bucket) => {
      const { find_uid, err, limiters, target_groups } = this;
      const uid = limiters.has(key_or_uid) ? key_or_uid : find_uid(key_or_uid);
      if (!uid) {
        return err.throw("", "No target group found", key_or_uid, {
          groups: Object.fromEntries(target_groups.entries())
        });
      }
      const limiter = limiters.get(uid);
      limiter.bucket.set(bucket);
    }
  };
  static get buckets() {
    const { limiters } = this;
    const entries = limiters.keys().map((uid) => [uid, limiters.get(uid).bucket.get()]);
    return Object.fromEntries(entries);
  }
  static get targets() {
    return Object.fromEntries(this.target_groups.entries());
  }
  static hash = hash;
  static err = {
    message: (uid, mssg) => {
      if (uid.length)
        uid = ` [${uid}]`;
      return `[${this.class_name}]${uid} ${mssg}`;
    },
    reject: (uid, mssg, ...reasons) => {
      if (typeof mssg !== "string")
        return Promise.reject(this.err.ensure_error(mssg));
      mssg = this.err.message(uid, mssg);
      const err = Error(mssg, { cause: reasons });
      return Promise.reject(err);
    },
    throw: (uid, mssg, ...details) => {
      throw Error(this.err.message(uid, mssg), { cause: details });
    },
    warn: (uid, mssg, ...data) => {
      mssg = this.err.message(uid, mssg);
      console.warn(mssg, ...data);
    },
    ensure_error: (err) => {
      try {
        return err instanceof Error ? err : typeof err === "string" ? Error(err) : typeof err === "number" ? Error(String(err)) : typeof err === "object" && Object.hasOwn(err, "toString") && err.toString instanceof Function ? Error(err.toString()) : typeof err === "object" ? Error(JSON.stringify(err)) : Error("unknown error");
      } catch (_err) {
        return Error("unknown error");
      }
    }
  };
  static find_uid = (target_key) => {
    const { target_groups } = this;
    const entry = target_groups.entries().find(([_uid, targets]) => targets.includes(target_key));
    return entry ? entry[0] : undefined;
  };
  static set_limiter = (target_keys, hash_id, limiter) => {
    const { limiters, target_groups, all_target_keys } = this;
    limiters.set(hash_id, limiter);
    target_groups.set(hash_id, target_keys);
    this.all_target_keys = [...all_target_keys, ...target_keys].sort((a, b) => b.length - a.length);
  };
  static class_name;
  static all_target_keys = [];
  static target_groups = new Map;
  static limiters = new Map;
}
var period_ms = (() => {
  const sec = 1000;
  const min = sec * 60;
  const hr = min * 60;
  const day = hr * 24;
  return { sec, min, hr, day };
})();

// src/LibCallback.ts
class LibCallback {
  retry = {
    generic_factory: (retry_status = [429, 503], max_error, max_fail) => {
      let errs = 0;
      let fails = 0;
      return (res) => {
        if (res instanceof Error) {
          if (!max_error)
            return false;
          errs++;
          return errs >= max_error;
        }
        if (retry_status.includes(res.status)) {
          if (!max_fail)
            return true;
          fails++;
          return fails >= max_fail;
        }
        return false;
      };
    }
  };
  wait = {
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
    response_factory: (header_key, val_cb) => (res) => {
      if (res instanceof Error)
        return val_cb(res);
      return val_cb(res.headers.get(header_key));
    }
  };
  response = {
    generic: async (res) => {
      const type = res.headers.get("content-type");
      if (!type)
        return res;
      if (type.includes("json"))
        return await res.json();
      if (type.includes("text"))
        return await res.text();
      return res;
    }
  };
  trace = {
    generic: (data) => {
      console.info(data);
    }
  };
}

// demo/wikidata/lib/strings.ts
var frmt = {
  bold: (text) => {
    return `\x1B[1m${text}\x1B[0m`;
  },
  dim: (text) => {
    return `\x1B[2m${text}\x1B[0m`;
  },
  braces_sqr: (text) => {
    return frmt.dim("[") + frmt.bold(text) + frmt.dim("]");
  },
  strip_ascii: (text) => {
    return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
  },
  lrg_num: (num) => {
    return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  }
};
var undef = frmt.dim("no translation");

// demo/wikidata/lib/WikiApi.ts
class WikiApi {
  lang;
  constructor(lang) {
    this.lang = lang;
  }
  search = (term, limit = 50, next, ...statements) => {
    const { headers, api } = this;
    const url = new URL(api.action);
    const controller = new AbortController;
    setTimeout(() => controller.abort(), 8000);
    url.search = params();
    if (next)
      Object.entries(next).forEach(([key, val]) => url.searchParams.set(key, String(val)));
    return new Request(url, { headers, signal: controller.signal });
    function params() {
      const _statements = statements.map((s) => `haswbstatement:${s}`).join(" ");
      return new URLSearchParams({
        action: "query",
        list: "search",
        format: "json",
        srlimit: String(limit),
        srsearch: `${term} ${_statements}`,
        origin: "*"
      }).toString();
    }
  };
  explore = (topic) => {
    const { headers, api } = this;
    const controller = new AbortController;
    setTimeout(() => controller.abort(), 8000);
    const url = new URL(`${api.entity}/${topic}.json`);
    return new Request(url, { headers, signal: controller.signal });
  };
  definitions = (ids, limit = 50) => {
    const { frmt: frmt2, api, headers } = this;
    const batches = frmt2.batch_ids(ids, limit);
    return batches.map(props);
    function props(props2) {
      const url = new URL(api.action);
      url.searchParams.set("action", "wbgetentities");
      url.searchParams.set("ids", props2.join("|"));
      url.searchParams.set("format", "json");
      url.searchParams.set("props", "labels|descriptions");
      return new Request(url, { headers });
    }
  };
  merge_definitions = (batches) => {
    const definitions = {};
    return batches.reduce((defs, batch) => {
      defs = { ...defs, ...batch };
      return defs;
    }, definitions);
  };
  claims_entity = (entities, qid) => {
    const { prune, frmt: frmt2 } = this;
    const entity = entities[qid];
    const { descriptions, labels, aliases } = entity;
    const description = frmt2.lang_val(descriptions) || undef;
    const label = frmt2.lang_val(labels) || frmt2.lang_alias_val(aliases) || undef;
    const claims = prune.claims(entity.claims);
    return { qid, description, label, claims };
  };
  defs_entity = (entities) => {
    const { frmt: frmt2 } = this;
    const definitions = {};
    Object.entries(entities).sort(([a], [b]) => to_num(a) - to_num(b)).reduce((entities2, [pid, prop]) => {
      const { labels, descriptions } = prop;
      const description = frmt2.lang_val(descriptions) || undef;
      const label = frmt2.lang_val(labels) || undef;
      entities2[pid] = { description, label, id: pid };
      return entities2;
    }, definitions);
    return definitions;
    function to_num(pid) {
      return Number(pid.replace("P", ""));
    }
  };
  prune = {
    claims: (claims) => {
      const { prune } = this;
      const frmtd_claims = {};
      Object.entries(claims).forEach(([qid, claim_array]) => {
        frmtd_claims[qid] = validate_claims(claim_array.map((claim) => prune.claim(claim)));
      });
      return frmtd_claims;
      function validate_claims(claim_array) {
        return claim_array.filter(claim_filter).sort(claim_sort);
      }
      function claim_filter(c) {
        return c.rank !== "deprecated";
      }
      function claim_sort(a, b) {
        const num_a = a.rank === "preferred" ? 1 : 0;
        const num_b = b.rank === "preferred" ? 1 : 0;
        return num_b - num_a;
      }
    },
    claim: (claim) => {
      const { frmt: frmt2 } = this;
      const wiki = frmt2.is_wiki_snak(claim.mainsnak);
      const description = frmt2.snak(claim.mainsnak);
      const label = claim.mainsnak.datatype;
      const claim_qualifiers = Object.values(claim.qualifiers || {}).flat();
      const qualifiers = frmt2.snaks(claim_qualifiers);
      const claim_q_order = claim["qualifiers-order"] || [];
      const qualifiers_order = claim_q_order.filter((pid) => !!qualifiers[pid]);
      const rank = claim.rank;
      const id = claim.id;
      return {
        id,
        wiki,
        description,
        label,
        qualifiers,
        qualifiers_order,
        rank
      };
    }
  };
  frmt = {
    batch_ids: (array, size, collect = []) => {
      const { frmt: frmt2 } = this;
      if (array.length <= size && !collect.length)
        return [array];
      if (array.length <= size)
        return [...collect, array];
      const batch = array.splice(0, size - 1);
      collect.push(batch);
      return frmt2.batch_ids(array, size, collect);
    },
    is_wiki_snak: (snak) => {
      return ["wikibase-item"].includes(snak.datatype) && snak.datavalue?.value.id;
    },
    snaks: (snaks) => {
      const { frmt: frmt2 } = this;
      const cat_snaks = {};
      snaks.forEach((snak) => {
        const { property } = snak;
        cat_snaks[property] ??= {};
        const snak_string = frmt2.snak(snak);
        if (!snak_string)
          return;
        const is_wiki = frmt2.is_wiki_snak(snak);
        cat_snaks[property].wiki = is_wiki ? snak_string : undefined;
        cat_snaks[property].val = is_wiki ? undefined : snak_string;
      });
      return cat_snaks;
    },
    snak: (snak) => {
      const { frmt: frmt2 } = this;
      if (!snak.datavalue?.value)
        return undef;
      if (frmt2.is_wiki_snak(snak))
        return snak.datavalue.value.id;
      const { type } = snak.datavalue;
      if (Array.isArray(snak.datavalue.value))
        return snak.datavalue.value.map((val) => typeof val === "object" ? JSON.stringify(val) : String(val)).join(", ");
      if (typeof snak.datavalue.value === "object")
        return Object.entries(snak.datavalue.value).map(([key, val], i) => {
          if (!i && type.endsWith(key))
            return frmt.bold(String(val));
          if (!i && type === "quantity" && key === "amount")
            return frmt.bold(String(val));
          key = `${frmt.dim(key)}:`;
          return `${key} ${val}`;
        }).join(", ");
      return String(snak.datavalue.value);
    },
    lang_alias_val: (vals) => {
      const { lang } = this;
      if (vals[lang]?.[0]?.value)
        return vals[lang][0].value;
      if (vals["mul"]?.[0]?.value)
        return vals["mull"][0].value;
      const _lang = Object.keys(vals).find((key) => key.startsWith(`${lang}-`));
      if (_lang && vals[_lang]?.[0]?.value)
        return vals[_lang][0].value;
      const label = Object.values(vals)[0]?.[0]?.value;
      return label ? `${label} (no ${lang})` : undef;
    },
    lang_val: (vals) => {
      const { lang } = this;
      if (vals[lang]?.value)
        return vals[lang]?.value;
      if (vals["mul"]?.value)
        return vals["mul"]?.value;
      let _lang = Object.keys(vals).find((key) => key.startsWith(`${lang}-`));
      if (_lang && vals[_lang]?.value)
        return vals[_lang]?.value;
    }
  };
  api = {
    action: "https://www.wikidata.org/w/api.php",
    entity: "https://www.wikidata.org/wiki/Special:EntityData"
  };
  headers = new Headers({
    "User-Agent": "fetchmanager/0.0 (https://github.com/citkane/fetchmanager/; noop@noop.com)"
  });
}

// demo/browser/index.ts
var lib_fetch = new LibCallback;
var language = "en";
var wiki = new WikiApi(language);
var time_period = "min";
var rpp_max = 200;
var concurrency_max = 3;
var handlers = {
  trace: (trace_data) => {
    let { paused, message, concurrency, tokens, href } = trace_data;
    let log = [];
    const det = message && message !== "queue empty";
    det && log.push(message);
    det && paused && log.push(`paused: ${paused}`);
    det && concurrency && log.push(`concurrency: ${concurrency}`);
    log.length && log.push(`tokens: ${tokens}`);
    !log.length && log.push(`Fetching: ${decodeURI(href)}\r`);
    console.log(log);
  },
  response: () => {
    return async (resp, _req) => resp.json().then((data) => data);
  },
  pager: async (resp, req, collect) => {
    const { continue: next, query } = await resp.json();
    collect(query.search);
    if (!next)
      return;
    const url = new URL(req.url);
    url.searchParams.set("continue", next.continue);
    url.searchParams.set("sroffset", String(next.sroffset));
    return new Request(url, req);
  },
  retry: (resp, _req) => {
    if (resp instanceof Error)
      return false;
    const { status } = resp;
    return [503, 429].includes(status);
  },
  wait: lib_fetch.wait.backoff_factory()
};
var fm = new FetchManager(rpp_max, concurrency_max, time_period, ["www.wikidata.org"], {
  wait_cb: handlers.wait,
  retry_cb: handlers.retry,
  trace_cb: handlers.trace
});
search("fetch").then((data) => console.log(data));
async function search(term, limit, next) {
  const req = wiki.search(term, limit, next);
  const pager_cb = handlers.pager;
  const response_cb = handlers.response();
  const paged_params = [req, pager_cb];
  const fetch_params = [req, { response_cb }];
  return (limit ? fm.fetch(...fetch_params) : fm.fetch(...paged_params)).catch((err) => {
    if (err instanceof Response)
      throw `${err.status} - ${err.statusText}`;
    throw err;
  });
}
