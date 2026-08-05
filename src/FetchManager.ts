/// <reference path="../types/types.d.ts" />

export default class FetchManager<G extends fm.kind> {
  constructor(...opts: fm.opts.instance<G>) {
    const default_opts = {
      timeout_ms: 500,
      heartbeat: 20,
    };
    const { limiters } = FetchManager;
    const { err, hosts, args, dequeue, limiter_factory } = this;
    const new_hosts: fm.host<G>[] = opts[3];
    if (!new_hosts.length) err.throw("No hosts given in constructor", opts);

    const new_host_keys = hosts.make_host_keys(new_hosts);
    const err_mssg = args.do_hosts_clash(new_host_keys, limiters);
    if (err_mssg) {
      err.throw(err_mssg, opts, {
        new_host_keys,
        ex_host_keys: Object.keys(limiters),
      });
    }

    this.fetch = this.fetch.bind(this);
    this.host_keys = new_host_keys;
    if (limiters.has(this.host_keys)) {
      const mssg = "Host set was already defined. Previous options are used.";
      err.warn(mssg, this.host_keys);
      return;
    }

    opts[4] = args.constructor_opts(default_opts, ...opts);
    const limiter: fm.p.limiter<fm.kind> = limiter_factory(...opts) as any;
    limiters.set(this.host_keys, limiter);

    setInterval(dequeue, opts[4].heartbeat);
  }

  /* Overloads for wrapped `fetch` */
  public fetch<T = fm.fol.resp, K extends fm.fol.knd = G>(
    ...p: fm.fol.r_o<K>
  ): Promise<T>;
  public fetch<T = fm.fol.resp, K extends fm.fol.knd = G>(
    ...p: fm.fol.r_p<K>
  ): Promise<T[]>;
  public fetch<T = fm.fol.resp, K extends fm.fol.knd = G>(
    ...p: fm.fol.r_o_p<K>
  ): Promise<T[]>;
  public fetch<T = fm.fol.resp, K extends fm.fol.knd = G>(
    ...p: fm.fol.u_i
  ): Promise<T>;
  public fetch<T = fm.fol.resp, K extends fm.fol.knd = G>(
    ...p: fm.fol.u_o<K>
  ): Promise<T>;
  public fetch<T = fm.fol.resp, K extends fm.fol.knd = G>(
    ...p: fm.fol.u_o_p<K>
  ): Promise<T[]>;
  public fetch<T = fm.fol.resp, K extends fm.fol.knd = G>(
    ...p: fm.fol.u_p<K>
  ): Promise<T[]>;
  public fetch<T = fm.fol.resp, K extends fm.fol.knd = G>(
    ...p: fm.fol.u_i_o<K>
  ): Promise<T>;
  public fetch<T = fm.fol.resp, K extends fm.fol.knd = G>(
    ...p: fm.fol.u_i_p<K>
  ): Promise<T[]>;
  public fetch<T = fm.fol.resp, K extends fm.fol.knd = G>(
    ...p: fm.fol.u_i_o_p<K>
  ): Promise<T[]>;

  /**
   * The wrapped native `fetch` method
   * */
  public fetch(this: FetchManager<G>, ...pms: fm.fol.fetch_pms<G>) {
    const { queue_req, args, err } = this;
    const { fetch_overload_args, make_ctx, ident_req_kind } = args;
    const { reject } = err;
    const req_or_url: string | Request = pms[0];
    const kind = ident_req_kind(req_or_url);
    if (!kind) return reject("A `Request.url` or url string must be provided.");

    const ctx_pms = fetch_overload_args(kind, ...pms);
    const part_ctx = make_ctx(ctx_pms);
    return queue_req(part_ctx);
  }

  /**
   * The native fetch implementation
   * */
  private native_fetch = (ctx: fm.p.ctx<G>) => {
    const { url, req_init, req } = ctx.ctx_req;
    const req_clone = req ? req.clone() : undefined;
    return req_clone ? fetch(req_clone) : fetch(url!, req_init);
  };

  private queue_req = async (part_ctx: Partial<fm.p.ctx<G>>) => {
    const { fetch_factory, unshift_queue, push_queue, err } = this;
    const { skip_queue, hostname, resolve } = part_ctx;
    const full_ctx = !!resolve ? (part_ctx as fm.p.ctx<G>) : undefined;
    if (full_ctx) {
      const req_fn = fetch_factory(full_ctx);
      skip_queue ? unshift_queue(req_fn) : push_queue(req_fn);
      return;
    }

    const def = { defined: this.host_keys };
    const is_def = def.defined.includes(hostname!);
    if (!is_def) return err.reject(`Hostname not defined: ${hostname}`, def);

    return new Promise((resolve, reject) => {
      const full_ctx = { ...part_ctx, resolve, reject } as fm.p.ctx<G>;
      const req_fn = fetch_factory(full_ctx);
      skip_queue ? unshift_queue(req_fn) : push_queue(req_fn);
    });
  };

  private dequeue = () => {
    const { limiter, handle } = this;
    const { reqs, paused, rpp } = limiter;
    const is_stopped = reqs.stop(),
      is_throttled = rpp.throttle(),
      is_paused = paused.refr_state();

    const ctx = reqs.queue[0]?.get_ctx();
    if (ctx) setTimeout(() => handle.trace(ctx));
    if (is_stopped || is_throttled || is_paused) return;

    const { execute_fetch } = reqs.queue.shift()!;
    rpp.increment();
    reqs.incr_concurrent();
    execute_fetch();
  };

  private push_queue = (fns: fm.p.fetch_fn<G>) => {
    const { queue } = this.limiter.reqs;
    queue.push(fns);
  };

  private unshift_queue = (fns: fm.p.fetch_fn<G>) => {
    const { queue } = this.limiter.reqs;
    queue.unshift(fns);
  };

  private fetch_factory = (ctx: fm.p.ctx<G>): fm.p.fetch_fn<G> => {
    const { response_cb, pager_cb, resolve, reject, ctx_req } = ctx;
    const { limiter, handle, args, native_fetch } = this;
    const { reqs } = limiter;
    const { pager, error } = handle;
    const { to_fm_req } = args;
    return {
      execute_fetch,
      get_ctx: () => ctx,
    };

    async function execute_fetch() {
      let resp: Response;
      try {
        resp = await native_fetch(ctx);
      } catch (err) {
        reqs.decr_concurrent();
        return error(ctx, err as Error);
      }
      reqs.decr_concurrent();
      if (!resp.ok) return error(ctx, resp);
      if (pager_cb) return pager(ctx, resp, pager_cb);
      if (!response_cb) return resp;

      try {
        const req = to_fm_req(ctx_req);
        const data = response_cb(resp, req);
        resolve(data);
      } catch (err) {
        reject(err);
      }
    }
  };

  private limiter_factory = (
    max_rpp: number,
    max_concurrency: number,
    rpp_period: fm.period,
    fm_hosts: fm.host<G>[],
    options?: fm.opts.global<G>,
  ): fm.p.limiter<G> => {
    const { handle, err } = this;
    const hosts = this.hosts.fm_to_ctx_hosts(fm_hosts);
    const { response_cb, retry_cb, timeout_cb, trace_cb } = options!;
    const reqs = reqs_factory(max_concurrency);
    const paused = paused_factory(options!);
    const rpp = rpp_factory(rpp_period, max_rpp);

    return {
      timeout_ms: options!.timeout_ms!,
      hosts,
      reqs,
      paused,
      rpp,
      response_cb,
      retry_cb,
      timeout_cb,
      trace_cb,
    };

    function paused_factory(options: fm.opts.global<G>): fm.p.limiter_paused {
      const { warn } = err;
      const { trace } = handle;
      const { heartbeat } = options;
      const paused = { set_state, refr_state, state, ms: 0 };
      return paused;

      function refr_state() {
        paused.ms = paused.ms ? paused.ms - heartbeat! : 0;
        paused.ms = paused.ms < 0 ? 0 : paused.ms;
        return state();
      }
      function set_state(ms: number) {
        if (!ms) return;
        if (ms < 0) return warn(`Cannot pause on negative (${ms})ms`);

        ms = Math.ceil(ms / heartbeat!) * heartbeat!;
        if (ms <= paused.ms) return;

        paused.ms = ms;
        const ctx = reqs.queue[0]?.get_ctx();
        if (ctx) trace(ctx, `Fetch is paused for ${paused.ms}ms`);
      }
      function state() {
        return paused.ms > 0;
      }
    }

    function reqs_factory(max_concurrency: number): fm.p.limiter_reqs<G> {
      const reqs = {
        queue: [],
        concurrency: 0,
        max_concurrency,
        incr_concurrent,
        decr_concurrent,
        stop,
        why_stopped,
      };
      return reqs;

      function incr_concurrent() {
        reqs.concurrency++;
      }
      function decr_concurrent() {
        reqs.concurrency--;
      }
      function stop() {
        if (!reqs.queue.length) return true;
        return reqs.concurrency >= reqs.max_concurrency;
      }
      function why_stopped() {
        if (!stop()) return undefined;
        return !reqs.queue.length ? "queue empty" : "max concurrency";
      }
    }

    function rpp_factory(period: fm.period, max: number): fm.p.limiter_rpp {
      const rpp_period_ms = FetchManager.period_ms[period];
      const rpp_tracker: number[] = [];
      const rpp = { rate: 0, max, period, is_throttled, throttle, increment };
      return rpp;
      function is_throttled() {
        return rpp.rate >= max ? `[${rpp.rate}:${max}]` : undefined;
      }
      function throttle() {
        rpp.rate = calc_rpp();
        return rpp.rate >= max;
      }
      function increment() {
        const now = new Date().valueOf();
        rpp_tracker.push(now);
      }
      function calc_rpp() {
        const period_ago = new Date().valueOf() - rpp_period_ms;
        const index = rpp_tracker.findIndex((time) => time > period_ago);
        if (index === -1) return rpp_tracker.length;

        rpp_tracker.splice(0, index);
        return rpp_tracker.length;
      }
    }
  };

  private args = {
    constructor_opts: (
      required_options: fm.opts.global<G>,
      ...pms: fm.opts.instance<G>
    ) => {
      const user_options: fm.opts.global<G> = pms[4] || {};
      Object.entries(required_options).forEach((entry) => {
        const [key, value] = entry as [keyof fm.opts.global<G>, any];
        if (!user_options[key]) user_options[key] = value;
      });
      return user_options;
    },
    ident_req_kind: (req_or_url: string | Request) => {
      const req_kind: fm.kind | undefined =
        req_or_url instanceof Request && req_or_url.url.length
          ? "req"
          : typeof req_or_url === "string" && req_or_url.length
            ? "url"
            : undefined;
      return req_kind;
    },
    fetch_overload_args: (
      req_kind: fm.kind,
      ...pms: fm.fol.fetch_pms<G>
    ): fm.p.ctx_pms<G> => {
      return req_kind === "url" ? req_url_kind() : req_req_kind();

      function req_req_kind() {
        const [req, opt_page, page] = pms.filter(empty_obj) as [
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

      function req_url_kind() {
        const [url, init_opt_page, opt_page, page] = pms.filter(empty_obj) as [
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

      function empty_obj(obj: any) {
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
        const options: fm.opts.fetch<G> = {
          response_cb: undefined,
          trace_cb: undefined,
          skip_queue: undefined,
          force_retry: undefined,
        };
        return !!Object.keys(options).find((key) => Object.hasOwn(v, key));
      }
    },

    make_ctx: (pms: fm.p.ctx_pms<G>): Partial<fm.p.ctx<G>> => {
      const { hosts, limiter } = this;
      const { options, url, req, req_init, pager_cb } = pms;
      const hostname = hosts.hostname(url, req);
      const host = limiter.hosts[hostname]!;
      const ctx_req: fm.p.ctx_req = { url, req_init, req };
      const page_collector = { user: [] as any[], system: [] as Response[] };
      const handlers = cascade_handlers();
      return {
        ctx_req,
        hostname,
        skip_queue: false,
        force_retry: 0,
        page_collector,
        ...(options || {}),
        ...handlers,
      };

      function cascade_handlers() {
        const handler_keys: (keyof fm.p.handlers<G>)[] = [
          "response_cb",
          "retry_cb",
          "timeout_cb",
          "trace_cb",
        ];
        const handlers = {
          pager_cb,
        } as fm.p.handlers<G> & { pager_cb?: fm.cb.pager<G> };
        return [limiter, host, options].reduce((handlers, opts) => {
          handler_keys.forEach((key) => {
            if (opts && opts[key]) handlers[key] = opts[key] as any;
          });
          return handlers;
        }, handlers);
      }
    },

    do_hosts_clash: (
      host_keys: string[],
      limiters: typeof FetchManager.limiters,
    ) => {
      if (limiters.has(host_keys)) return false;

      const ex_hosts = [...limiters.keys()].flat();
      const clashing_hosts = host_keys.reduce((clash_hosts, this_host) => {
        const clash = ex_hosts.find((ex_host) => ex_host === this_host);
        if (!clash) return clash_hosts;
        clash_hosts.push(clash);
        return clash_hosts;
      }, [] as string[]);

      return clashing_hosts.length
        ? `Hosts already defined in other groups: [ ${clashing_hosts.join(", ")} ]`
        : false;
    },

    to_ctx_req: (fm_req: fm.req<G>): fm.p.ctx_req => {
      if (fm_req instanceof Request) return { req: fm_req };
      return fm_req;
    },

    to_fm_req: (ctx_req: fm.p.ctx_req): fm.req<G> => {
      const { req, url, req_init } = ctx_req;
      if (req) return req.clone() as fm.req<G>;
      return { url, req_init } as fm.req<G>;
    },
  };

  private hosts = {
    make_debug_data: (ctx: fm.p.ctx<G>, mssg?: string): fm.trace_data => {
      const { force_retry, hostname, skip_queue } = ctx;
      const { rpp, reqs, paused } = this.limiter;
      const href = this.hosts.href(ctx);
      return {
        message: mssg,
        paused: paused.ms ? `${(paused.ms / 1000).toFixed(2)}sec` : undefined,
        stopped: reqs.why_stopped(),
        throttled: rpp.is_throttled(),
        rpp: rpp.rate,
        rpp_max: rpp.max,
        rpp_period: rpp.period,
        concurrency: reqs.concurrency,
        max_concurrency: reqs.max_concurrency,
        queue: reqs.queue.length,
        force_retry,
        skip_queue,
        hostname,
        href,
      };
    },

    make_host_keys: (hosts: fm.host<G>[]) => {
      const host_strings = hosts.map((host) => {
        return typeof host === "string" ? host : host.hostname;
      });
      return [...new Set(host_strings)];
    },

    fm_to_ctx_hosts: (hosts: fm.host<G>[]) => {
      const { err } = this;
      return hosts.reduce(reducer, {} as { [hostname: string]: fm.p.host<G> });

      function reducer(
        hosts: { [hostname: string]: fm.p.host<G> },
        fm_host: fm.host<G>,
      ) {
        const is_host = typeof fm_host !== "string";
        const host = is_host ? fm_host : { hostname: fm_host };
        const { hostname } = host;
        if (!hosts[hostname]) {
          hosts[hostname] = host;
          return hosts;
        }
        const mssg = `${hostname} is defined multiple times. Options from first instance retained`;
        err.warn(mssg, host);
        return hosts;
      }
    },

    href: (context: fm.p.ctx<G>) => {
      const { req, url } = context.ctx_req;
      const url_string = req ? req.url : url!;
      return new URL(url_string).href;
    },

    hostname: (url?: string, req?: Request) => {
      const url_string = req ? req.url : url!;
      let { hostname, port } = new URL(url_string);
      hostname = port ? `${hostname}:${port}` : hostname;
      return hostname;
    },
  };

  private handle = {
    error: (ctx: fm.p.ctx<G>, resp: Response | Error) => {
      const { retry, trace, should_retry } = this.handle;
      const { hosts, err } = this;
      const href = hosts.href(ctx);
      const mssg =
        resp instanceof Response
          ? err.message(`${resp.status} ${resp.statusText} for ${href}.`)
          : err.message(`Fetch errored before response for ${href}.`);
      trace(ctx, mssg);
      if (should_retry(ctx, resp)) return retry(ctx, resp);

      ctx.reject(resp);
    },

    should_retry: (ctx: fm.p.ctx<G>, resp: Response | Error) => {
      const { ctx_req, retry_cb, force_retry, reject } = ctx;
      const req = this.args.to_fm_req(ctx_req);
      if (force_retry) return true;
      if (!retry_cb) return false;

      try {
        resp = resp instanceof Response ? resp.clone() : resp;
        return retry_cb(resp, req);
      } catch (err) {
        reject(err);
        return false;
      }
    },

    retry: (ctx: fm.p.ctx<G>, resp: Response | Error) => {
      const { handle } = this;
      let { force_retry } = ctx;
      ctx.skip_queue = force_retry > 0 ? false : true;
      if (force_retry)
        ctx.force_retry = force_retry > 0 ? force_retry-- : force_retry++;
      handle.pause(ctx, resp);
      this.queue_req(ctx);
    },

    pause: (ctx: fm.p.ctx<G>, resp: Response | Error) => {
      const { timeout_cb, reject, ctx_req } = ctx;
      const { paused, timeout_ms } = this.limiter;
      const ms = timeout_ms;
      if (!timeout_cb) return paused.set_state(ms);

      try {
        const { to_fm_req } = this.args;
        resp = resp instanceof Response ? resp.clone() : resp;
        const ms = timeout_cb(resp, to_fm_req(ctx_req));
        paused.set_state(ms);
      } catch (err) {
        reject(err);
      }
    },

    trace: (context: fm.p.ctx<G>, mssg?: string) => {
      const { trace_cb } = context;
      const { make_debug_data } = this.hosts;
      if (!trace_cb) return;

      const data = make_debug_data(context, mssg);
      trace_cb(data);
    },

    pager: async (
      ctx: fm.p.ctx<G>,
      resp: Response,
      pager_cb: fm.cb.pager<G>,
    ) => {
      const { queue_req, args } = this;
      const { to_fm_req } = args;
      const { response_cb, resolve, reject, ctx_req, page_collector } = ctx;
      const { user, system } = page_collector;
      const req = to_fm_req(ctx_req);
      let new_req: fm.p.pager_cb_rtn<G>;
      try {
        new_req = await pager_cb(resp.clone(), req, user);
      } catch (err) {
        reject(err);
      }
      system.push(resp);
      if (new_req) {
        ctx.skip_queue = true;
        ctx.ctx_req = args.to_ctx_req(new_req);
        return queue_req(ctx);
      }
      if (user.length) return resolve(user);
      if (!response_cb) return resolve(system);
      try {
        const resp_array = await Promise.all(
          system.map((res) => response_cb(res, req)),
        );
        resolve(resp_array);
      } catch (err) {
        reject(err);
      }
    },
  };

  private err = {
    message: (mssg: string) => {
      return `[${this.class_name}] ${mssg}`;
    },

    reject: (mssg: string, ...warn: any[]) => {
      if (warn && warn.length) this.err.warn(mssg, ...warn);
      mssg = this.err.message(mssg);
      return new Promise((_res, rej) => rej(mssg));
    },

    throw: (mssg: string, ...details: any[]) => {
      const cause = { message: mssg, details };
      throw Error(this.err.message(mssg), { cause });
    },

    warn: (mssg: string, ...data: any[]) => {
      mssg = this.err.message(mssg);
      console.warn(mssg, ...data);
    },
  };

  private get limiter() {
    if (this.static_limiter) return this.static_limiter!;
    return (this.static_limiter = FetchManager.limiters.get(
      this.host_keys,
    )! as fm.p.limiter<G>);
  }

  private host_keys: string[];
  private static_limiter?: fm.p.limiter<G>;
  private class_name = this.constructor.name;

  private static limiters = new Map<string[], fm.p.limiter<fm.kind>>();
  private static period_ms = (() => {
    const sec = 1000;
    const min = sec * 60;
    const hr = min * 60;
    const day = hr * 24;
    return { sec, min, hr, day };
  })();
}
