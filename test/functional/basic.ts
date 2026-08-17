import FetchManager from "fetchmanager";
import { server } from "../index.test.ts";
import { test, describe, expect } from "bun:test";

const urls = {
  status: "http://localhost:3000/api/status",
  "300ms": "http://localhost:3000/api/300ms",
};

describe("basic functionality", () => {
  test("it connects", async () => {
    const fm = new FetchManager(1, 1, "sec", ["localhost:3000"]);
    await fm.fetch(urls.status).then(async (res) => {
      expect(res.ok).toBe(true);
      const text = await res.text();
      expect(text).toBe("OK");
    });
    await fm.kill();
  });

  test("it limits the rate", async () => {
    const fm = new FetchManager(2, 100, "sec", ["localhost:3000"]);
    const promises = [...Array(4)].map(() => fm.fetch(urls.status));
    const then = new Date().valueOf();
    await Promise.all(promises);
    const now = new Date().valueOf();
    const delay = now - then;
    expect(delay).toBeGreaterThanOrEqual(1000);
    expect(delay).toBeLessThan(2000);
    await fm.kill();
  });

  test("it limits concurrency", async () => {
    const fm = new FetchManager(100, 2, "sec", ["localhost:3000"]);
    const promises = [...Array(3)].map(() => fm.fetch(urls["300ms"]));
    const then = new Date().valueOf();
    await Promise.all(promises);
    const now = new Date().valueOf();
    const delay = now - then;
    expect(delay).toBeGreaterThanOrEqual(600);
    expect(delay).toBeLessThan(900);
    await fm.kill();
  });

  test("it kills waiting requests", async () => {
    const fm = new FetchManager(1, 1, "sec", ["localhost:3000"]);
    fm.fetch(urls.status).catch(() => {
      throw "should succeed";
    });
    fm.fetch(urls.status)
      .then(() => {
        throw "shouldn't have resolved";
      })
      .catch((err) => {
        expect(err.message).toBe("Host group was killed");
      });
    await new Promise<void>((res) =>
      setTimeout(() => fm.kill().then(() => res()), 30),
    );
  });

  test("it cleanly stops the queue", async () => {
    const fm = new FetchManager(300, 3, "sec", ["localhost:3000"]);
    const promises = [...Array(5)].map(() =>
      fm.fetch(urls.status).then((res) => res.ok),
    );
    const ok = Promise.all(promises);
    await fm.stop();
    expect(ok).resolves.toEqual([...Array(5)].map(() => true));
    expect(fm.fetch(urls.status)).rejects.toThrow("Host group was killed");
  });

  test("it replaces unused tokens", async () => {
    await server.stop();
    const fm = new FetchManager(3, 3, "sec", ["localhost:3000"]);
    try {
      expect(fm.fetch(urls.status)).rejects.toBeInstanceOf(Error);
      const bucket = FetchManager.bucket.get("localhost:3000")!;
      expect(bucket.tokens).toBe(3);
      await fm.kill();
      server.start();
    } catch (err) {
      fm.kill().then(() => {
        server.start();
        throw err;
      });
    }
  });

  test("it gets and sets buckets", async () => {
    const fm = new FetchManager(10, 3, "sec", ["localhost:3000"]);
    let bucket = FetchManager.bucket.get("localhost:3000")!;
    expect(bucket).toEqual({
      max_concurrency: 3,
      max_rpp: 10,
      period: "sec",
      tokens: 10,
      concurrency: 0,
    });
    bucket.tokens = 5;
    bucket.concurrency = 3;
    FetchManager.bucket.set("localhost:3000", bucket);
    bucket = FetchManager.bucket.get("localhost:3000")!;
    expect(bucket).toEqual({
      max_concurrency: 3,
      max_rpp: 10,
      period: "sec",
      tokens: 5,
      concurrency: 3,
    });
    await fm.kill();
  });
});
