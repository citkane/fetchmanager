/// <reference path="../types/types.d.ts" />

export default class LibCallback<G extends fm.kind> implements fm.lib<G> {
  pager = {
    param_factory: (
      ctx: "headers" | "body",
      search_pms_cb: (count: number) => { [key: string]: string },
      count_key: string,
      flag_next_key?: string,
    ) => {
      return async (resp: Response, req: fm.req<G>) => {
        const [count, proceed] = await get_context(resp)
          .then(get_count)
          .then(should_proceed);
        if (!proceed) return;

        return get_search_params(count)
          .then((pms) => get_new_url(pms, req))
          .then((url) => make_new_req(url, req));
      };

      async function get_context(resp: Response): Promise<{
        [key: string]: number | string;
      }> {
        return ctx === "body"
          ? ((await resp.json()) as {})
          : Object.fromEntries(resp.headers.entries());
      }

      function get_count(context: { [key: string]: string | number }) {
        let count_val = context[count_key];
        if (!count_val && ctx === "headers")
          count_val = context[count_key.toLowerCase()];
        const count = count_val ? Number(count_val) : 0;
        if (Number.isNaN(count))
          throw `Failed to get pager count on key ${count_key}`;

        return [context, count] as const;
      }

      function should_proceed([context, count]: readonly [
        { [key: string]: string | number },
        number,
      ]) {
        if (!flag_next_key) return [count, count > 0] as const;
        return [count, !!context[flag_next_key]] as const;
      }

      async function get_search_params(count: number) {
        try {
          return new URLSearchParams(search_pms_cb(count));
        } catch (err) {
          throw new Error("search_pms_cb failed", { cause: err });
        }
      }

      function get_new_url(search_params: URLSearchParams, req: fm.req<G>) {
        const url = new URL(req.url);
        search_params.forEach((val, key) => url.searchParams.set(key, val));
        return url.toString();
      }

      function make_new_req(url: string, req: fm.req<G>) {
        return req instanceof Request
          ? (new Request(url, req as Request) as fm.req<G>)
          : ({ url, req_init: req.req_init } as fm.req<G>);
      }
    },
  };
  retry = {
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
          return errs >= max_error;
        }
        if (retry_status.includes(res.status)) {
          if (!max_fail) return true;
          fails++;
          return fails >= max_fail;
        }
        return false;
      };
    },
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
    response_factory:
      (header_key: string, val_cb: (time: string | null | Error) => number) =>
      (res: Response | Error) => {
        if (res instanceof Error) return val_cb(res);
        return val_cb(res.headers.get(header_key));
      },
  };
  response = {
    generic: async (res: Response) => {
      const type = res.headers.get("content-type");
      if (!type) return res;
      if (type.includes("json")) return await res.json();
      if (type.includes("text")) return await res.text();
      return res;
    },
  };
  trace = {
    generic: (data: fm.trace_data) => {
      console.info(data);
    },
  };
}
