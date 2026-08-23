import FetchManager from "fetch-manager";
import { test, describe, expect } from "bun:test";

const urls = {
  data: "http://localhost:3000/api/data",
  retry_after: "http://localhost:3000/api/retry/2",
  pager: "http://localhost:3000/api/pager",
  reset: "http://localhost:3000/api/reset",
};

describe("callback handling", () => {
  test("it uses response_cb", async () => {
    const response_cb: fm.cb.resp = (resp) => resp.json() as Promise<data>;
    const fm = new FetchManager(1, 1, "sec", ["localhost:3000"]);
    const data = await fm.fetch<data>(urls.data, { response_cb });
    expect(data.data).toBe(1);
    await fm.kill();
  });

  test("it uses retry_cb", async () => {
    let count = 0;
    const retry_cb: fm.cb.retry = (resp) => {
      if (count) throw count;
      count++;
      return resp instanceof Error ? false : resp.status === 429;
    };
    const fm = new FetchManager(100, 100, "sec", ["localhost:3000"]);
    const req = fm.fetch(urls.retry_after, { retry_cb });
    expect(req).rejects.toThrow("1");
    await fetch(urls.reset);
    await fm.kill();
  });

  test("it uses wait_cb", async () => {
    let count = 0;
    const retry_cb: fm.cb.retry = (resp, _req) => {
      if (count) throw count;
      count++;
      return resp instanceof Error ? false : resp.status === 429;
    };
    const wait_cb: fm.cb.wait = () => 800;
    const fm = new FetchManager(100, 100, "sec", ["localhost:3000"]);
    const then = new Date().valueOf();
    const req = fm.fetch(urls.retry_after, { retry_cb, wait_cb });
    expect(req).rejects.toThrow("1");
    const now = new Date().valueOf();
    expect(now - then).toBeGreaterThan(800);
    await fetch(urls.reset);
    await fm.kill();
  });

  test("it uses trace callback", async () => {
    let data: any[] = [];
    const trace_cb: fm.cb.trace = (trace) => {
      if (trace.message && !data.includes(trace.message))
        data.push(trace.message);
    };
    const fm = new FetchManager(3, 1, "sec", ["localhost:3000"]);
    const promises = [...Array(4)].map(() => fm.fetch(urls.data, { trace_cb }));
    await Promise.all(promises);
    expect(data).toEqual(["max concurrency", "rate limit exceeded"]);
    await fm.kill();
  });

  test("it uses pager_cb", async () => {
    const pager_cb =
      (use_collect = true, flat = true): fm.cb.pager<fm.kind> =>
      async (res, req, collect) => {
        const data = await res.json();
        const next = res.headers.get("next");
        if (use_collect) collect(data, flat);
        return next ? req : false;
      };
    const response_cb: fm.cb.resp = () => Promise.resolve(["res"]);
    const fm = new FetchManager(100, 100, "sec", ["localhost:3000"]);

    const res = await fm.fetch<string[]>(urls.pager, pager_cb());
    expect(res).toEqual(["OK", "OK"]);

    await fetch(urls.reset);
    const res2 = await fm.fetch<string[][]>(urls.pager, pager_cb(true, false));
    expect(res2).toEqual([["OK"], ["OK"]]);

    await fetch(urls.reset);
    const res3 = await fm.fetch<string[][]>(
      urls.pager,
      { response_cb },
      pager_cb(false),
    );
    expect(res3).toEqual([["res"], ["res"]]);

    const res4 = await fm.fetch<Response[]>(urls.pager, pager_cb(false));
    expect(res4).toBeArray();
    res4.forEach((res) => {
      expect(res).toBeInstanceOf(Response);
    });

    await fetch(urls.reset);
    await fm.kill();
  });
});

type data = { data: number };
