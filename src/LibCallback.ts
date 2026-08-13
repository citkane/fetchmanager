/// <reference path="./types.d.ts" />

export default class LibCallback<G extends fm.kind> implements fm.lib<G> {
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
