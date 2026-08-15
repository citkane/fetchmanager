import FetchManager from "fetchmanager";
import { test, describe, expect } from "bun:test";

const urls = {
  status: "http://localhost:3000/api/status",
  "300ms": "http://localhost:3000/api/300ms",
};
// const trace_cb: fm.cb.trace = (data) => console.info(data.concurrency);

describe("basic functionality", () => {
  test("it connects", async () => {
    const { fetch: fetch_m, kill } = new FetchManager(1, 1, "sec", [
      "localhost:3000",
    ]);
    await fetch_m(urls.status).then(async (res) => {
      expect(res.ok).toBe(true);
      const text = await res.text();
      expect(text).toBe("OK");
    });
    await kill();
  });

  test("it limits the rate", async () => {
    const { fetch: fetch_m, kill } = new FetchManager(2, 100, "sec", [
      "localhost:3000",
    ]);
    const promises = [...Array(4)].map(() => fetch_m(urls.status));
    const then = new Date().valueOf();
    await Promise.all(promises);
    const now = new Date().valueOf();
    const delay = now - then;
    expect(delay).toBeGreaterThanOrEqual(1000);
    expect(delay).toBeLessThan(2000);
    await kill();
  });

  test("it limits concurrency", async () => {
    const { fetch: fetch_m, kill } = new FetchManager(100, 2, "sec", [
      "localhost:3000",
    ]);
    const promises = [...Array(3)].map(() => fetch_m(urls["300ms"]));
    const then = new Date().valueOf();
    await Promise.all(promises);
    const now = new Date().valueOf();
    const delay = now - then;
    expect(delay).toBeGreaterThanOrEqual(600);
    expect(delay).toBeLessThan(900);
    await kill();
  });
});
