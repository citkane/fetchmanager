import FetchManager from "fetchmanager";
import { test, describe, expect } from "bun:test";

const urls = {
  data: "http://localhost:3000/api/data",
  retry_after: "http://localhost:3000/api/retry",
};

describe("Callback handling", () => {
  test("it uses response_cb", async () => {
    const response_cb: fm.cb.resp = (resp) => resp.json() as Promise<data>;

    const { fetch: fetch_m, kill } = new FetchManager(1, 1, "sec", [
      "localhost:3000",
    ]);

    const data = await fetch_m<data>(urls.data, { response_cb });
    expect(data.data).toBe(1);
    await kill();
  });

  test("it uses retry_cb", async () => {
    let count = 0;
    const retry_cb: fm.cb.retry = (resp) => {
      if (count) throw count;
      count++;
      return resp instanceof Error ? false : resp.status === 429;
    };
    const { fetch: fetch_m, kill } = new FetchManager(100, 100, "sec", [
      "localhost:3000",
    ]);

    const req = fetch_m(urls.retry_after, { retry_cb });
    expect(req).rejects.toThrow("1");

    await kill();
  });

  test("it uses wait_cb", async () => {
    let count = 0;
    const retry_cb: fm.cb.retry = (resp, _req) => {
      if (count) throw count;
      count++;
      return resp instanceof Error ? false : resp.status === 429;
    };
    const wait_cb = () => 800;
    const { fetch: fetch_m, kill } = new FetchManager(100, 100, "sec", [
      "localhost:3000",
    ]);
    const then = new Date().valueOf();
    const req = fetch_m(urls.retry_after, { retry_cb, wait_cb });
    expect(req).rejects.toThrow("1");
    const now = new Date().valueOf();
    expect(now - then).toBeGreaterThan(800);
    await kill();
  });

  test("it uses trace callback", async () => {
    let data: any[] = [];
    const trace_cb: fm.cb.trace = (trace) => {
      data.push(trace);
    };
    const { fetch: fetch_m, kill } = new FetchManager(100, 100, "sec", [
      "localhost:3000",
    ]);
    await fetch_m(urls.data, { trace_cb });
    setTimeout(async () => {
      expect(data.length).toBe(1);
      await kill();
    }, 20);
  });
});

type data = { data: number };
