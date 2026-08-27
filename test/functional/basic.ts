import FetchManager from "fetch-manager";
import { server } from "../index.test.ts";
import { test, describe, expect } from "bun:test";

const urls = {
  status: "http://localhost:3000/api/status",
  slow: "http://localhost:3000/api/slow/300",
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
    const promises = [...Array(3)].map(() => fm.fetch(urls["slow"]));
    const then = new Date().valueOf();
    await Promise.all(promises);
    const now = new Date().valueOf();
    const delay = now - then;
    expect(delay).toBeGreaterThanOrEqual(600);
    expect(delay).toBeLessThan(900);
    await fm.kill();
  });

  test("it kills waiting requests", async () => {
    let trace = {} as fm.trace_data;
    const trace_cb: fm.cb.trace = (data) => {
      trace = data;
    };
    const fm = new FetchManager(1, 1, "sec", ["localhost:3000"], { trace_cb });
    const r1 = fm.fetch(urls.status).catch(() => {
      throw "should succeed";
    });
    const r2 = fm
      .fetch(urls.status)
      .then(() => {
        throw "shouldn't have resolved";
      })
      .catch((err) => err.message);
    await new Promise<void>((res) =>
      setTimeout(() => fm.kill().then(() => res()), 30),
    );
    expect(r1).resolves.toBeInstanceOf(Response);
    expect(r2).resolves.toBe("Target group was killed");
    expect(trace.queue).toBe(0);
    expect(trace.message).toBe("Target group was killed");
  });

  test("it cleanly stops the queue", async () => {
    let trace = {} as fm.trace_data;
    const trace_cb: fm.cb.trace = (data) => {
      trace = data;
    };
    const fm = new FetchManager(300, 3, "sec", ["localhost:3000"], {
      trace_cb,
    });
    const promises = [...Array(5)].map(() =>
      fm.fetch(urls.status).then((res) => res.ok),
    );
    const ok = Promise.all(promises);
    await fm.stop();
    expect(ok).resolves.toEqual([...Array(5)].map(() => true));
    expect(trace.queue).toBe(0);
    expect(trace.message).toBe("Target group was stopped");
    expect(fm.fetch(urls.status)).rejects.toThrow("Target group was killed");
  });

  test("it replaces unspent tokens", async () => {
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

  test("it gets all buckets", async () => {
    const fm = new FetchManager(10, 3, "sec", ["localhost:3000"]);
    const fm2 = new FetchManager(10, 3, "sec", ["foo.com"]);
    expect(Object.keys(FetchManager.buckets).length).toBe(2);
    expect(FetchManager.buckets[fm.uid]).toEqual({
      uid: "d18909e7",
      max_rpp: 10,
      max_concurrency: 3,
      period: "sec",
      tokens: 10,
      concurrency: 0,
      time: 0,
    });
    await fm.kill();
    await fm2.kill();
  });

  test("it gets and sets a bucket", async () => {
    const fm = new FetchManager(10, 3, "sec", ["localhost:3000"]);
    let bucket = FetchManager.bucket.get("localhost:3000")!;
    expect(bucket).toEqual({
      uid: expect.any(String),
      max_concurrency: 3,
      max_rpp: 10,
      period: "sec",
      tokens: 10,
      concurrency: 0,
      time: expect.any(Number),
    });
    bucket.tokens = 5;
    bucket.concurrency = 3;
    const uid = Object.keys(FetchManager.targets)[0]!;
    FetchManager.bucket.set(uid, bucket);
    bucket = FetchManager.bucket.get(uid)!;
    expect(bucket).toEqual({
      uid: expect.any(String),
      max_concurrency: 3,
      max_rpp: 10,
      period: "sec",
      tokens: 5,
      concurrency: 3,
      time: expect.any(Number),
    });
    await fm.kill();
  });

  // sends 1000 requests at a rate limit of 10,000/s on the cpu clock tick
  test("it is accurate under load", async () => {
    let trace = {} as fm.trace_data;
    const trace_cb: fm.cb.trace = (data) => (trace = data);
    const fm = new FetchManager(10000, 1000, "sec", ["localhost:3000"], {
      heartbeat: 0,
      trace_cb,
    });
    const promises = [...Array(1000)].map(() => fm.fetch(urls.status));
    const resp = await Promise.all(promises);
    expect(resp.length).toBe(1000);
    // wait for next cpu tick
    await new Promise((r) => setTimeout(r));
    expect(trace.queue).toBe(0);
    expect(trace.concurrency).toBe(0);
    // It is refilling the bucket as expected
    expect(trace.tokens).toBe(10000);
    expect(trace.message).toBe("queue empty");
    await fm.kill();
  });
});
