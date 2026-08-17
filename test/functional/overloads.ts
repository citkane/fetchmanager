import FetchManager from "fetchmanager";
import { test, describe, expect } from "bun:test";

const urls = {
  retry_after: "http://localhost:3000/api/retry/1",
  pager: "http://localhost:3000/api/pager",
  reset: "http://localhost:3000/api/reset",
};

describe("fetch overloads", () => {
  test("overload request", async () => {
    const fm = new FetchManager(1, 1, "sec", ["localhost:3000"]);

    const req = new Request(urls.retry_after);
    let res = await fm.fetch(req, {}).catch((err) => {
      expect(err).toBeInstanceOf(Response);
      expect(err.status).toBe(429);
      return true;
    });
    expect(res).toBe(true);

    await fetch(urls.reset);
    res = await fm.fetch(urls.retry_after, { method: "GET" }).catch((err) => {
      expect(err).toBeInstanceOf(Response);
      expect(err.status).toBe(429);
      return true;
    });
    expect(res).toBe(true);

    await fetch(urls.reset);
    await fm.kill();
  });

  test("overload options", async () => {
    let track: any[] = [];
    const handlers: {
      retry_cb: fm.cb.retry;
      wait_cb: fm.cb.wait;
      response_cb: fm.cb.resp;
    } = {
      retry_cb: (resp, _req) => {
        if (resp instanceof Error) return false;
        track.push(resp.status);
        return resp.status === 429;
      },
      wait_cb: (resp) => {
        if (resp instanceof Error) return 0;
        const wait = resp.headers.get("Retry-After") || "999";
        track.push(wait);
        return Number(wait);
      },
      response_cb: async (resp) => {
        if (resp instanceof Error) throw resp;
        const data = await resp.text();
        track.push(data);
        return data;
      },
    };
    const pager_cb: fm.cb.pager = async (res, req, collect) => {
      const data = await res.json();
      const next = res.headers.get("next");
      collect(data);
      return next ? req : false;
    };

    const fm = new FetchManager(100, 100, "sec", ["localhost:3000"]);

    let req = new Request(urls.retry_after);
    let res = await fm.fetch<string>(req, handlers);
    expect(res).toBe("OK");
    expect(track).toEqual([429, "600", "OK"]);

    track = [];
    await fetch(urls.reset);
    res = await fm.fetch<string>(urls.retry_after, handlers);
    expect(res).toBe("OK");
    expect(track).toEqual([429, "600", "OK"]);

    track = [];
    await fetch(urls.reset);
    res = await fm.fetch<string>(urls.retry_after, { method: "GET" }, handlers);
    expect(res).toBe("OK");
    expect(track).toEqual([429, "600", "OK"]);

    await fetch(urls.reset);
    req = new Request(urls.pager);
    let res2 = await fm.fetch<string[]>(req, pager_cb);
    expect(res2).toEqual(["OK", "OK"]);

    await fetch(urls.reset);
    req = new Request(urls.pager);
    res2 = await fm.fetch<string[]>(req, handlers, pager_cb);
    expect(res2).toEqual(["OK", "OK"]);

    await fetch(urls.reset);
    res2 = await fm.fetch<string[]>(urls.pager, pager_cb);
    expect(res2).toEqual(["OK", "OK"]);

    await fetch(urls.reset);
    res2 = await fm.fetch<string[]>(urls.pager, handlers, pager_cb);
    expect(res2).toEqual(["OK", "OK"]);

    await fetch(urls.reset);
    res2 = await fm.fetch<string[]>(
      urls.pager,
      { method: "GET" },
      handlers,
      pager_cb,
    );
    expect(res2).toEqual(["OK", "OK"]);

    await fetch(urls.reset);
    res2 = await fm.fetch<string[]>(urls.pager, {}, handlers, pager_cb);
    expect(res2).toEqual(["OK", "OK"]);

    await fetch(urls.reset);
    await fm.kill();
  });
});
