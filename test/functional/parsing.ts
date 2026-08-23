import FetchManager from "fetch-man";
import { test, describe, expect } from "bun:test";

const urls = {
  status: "http://localhost:3000/api/status",
  data: "http://localhost:3000/api/data",
  pager: "http://localhost:3000/api/pager",
  retry: (after: number) => `http://localhost:3000/api/retry/${after}`,
  slow: (ms: number) => `http://localhost:3000/api/slow/${ms}`,
  reset: "http://localhost:3000/api/reset",
};

describe("parsing", () => {
  test("it hits pathnames in correct order", async () => {
    await fetch(urls.reset);
    const fm = new FetchManager(1, 1, "sec", [
      "localhost:3000",
      "localhost:3000/api/status",
      "localhost:3000/reset",
    ]);
    const fm2 = new FetchManager(1, 1, "sec", ["localhost:3000/api/pager"]);
    expect(fm2.fetch(urls.pager)).resolves.toBeInstanceOf(Response);
    expect(fm.fetch(urls.pager)).rejects.toThrowError(
      "Target in another group",
    );

    expect(fm.fetch(urls.status)).resolves.toBeInstanceOf(Response);
    let bucket = FetchManager.bucket.get("localhost:3000/api/status");
    expect(bucket).toBeDefined();
    let uid = bucket!.uid;
    expect(uid).toBe(fm.uid);
    expect(FetchManager.targets[fm.uid]).toEqual([
      "localhost:3000/api/status",
      "localhost:3000/reset",
      "localhost:3000",
    ]);

    expect(fm.fetch(urls.data)).resolves.toBeInstanceOf(Response);
    bucket = FetchManager.bucket.get("localhost:3000");
    expect(bucket).toBeDefined();
    uid = bucket!.uid;
    expect(uid).toBe(fm.uid);
    expect(FetchManager.targets[uid]).toEqual([
      "localhost:3000/api/status",
      "localhost:3000/reset",
      "localhost:3000",
    ]);

    await fm.kill();
    await fm2.kill();
    await fetch(urls.reset);
  });

  test("it retries from fetch options", async () => {
    const trace_cb: fm.cb.trace = (_data) => {
      // console.log(_data);
    };
    const fm = new FetchManager(10, 10, "sec", ["localhost:3000"], {
      wait_ms: 200,
      trace_cb,
    });
    const then = new Date().valueOf();
    const res = fm.fetch(urls.retry(3), { force_retry: 3 });
    expect(res).resolves.toBeInstanceOf(Response);
    const delay = new Date().valueOf() - then;
    expect(delay).toBeGreaterThan(600);
    expect(delay).toBeLessThan(1000);
    await fm.kill();
    await fetch(urls.reset);
  });

  test("it retries from the back of the queue", async () => {
    const trace_cb: fm.cb.trace = (_data) => {
      // console.log(_data.message);
    };
    const data: string[] = [];
    const response_cb: fm.cb.resp<"url"> = (res, req) => {
      const url = new URL(req.url);
      data.push(url.pathname);
      return res;
    };
    const fm = new FetchManager(10, 10, "sec", ["localhost:3000"], {
      wait_ms: 500,
      response_cb,
      trace_cb,
    });

    const then = new Date().valueOf();
    const res = fm.fetch(urls.retry(3), { force_retry: 3 });
    const res_status = new Promise((res) =>
      setTimeout(() => res(fm.fetch(urls.status))),
    );
    expect(res_status).resolves.toBeInstanceOf(Response);
    let delay = new Date().valueOf() - then;
    expect(delay).toBeLessThan(60);

    expect(res).resolves.toBeInstanceOf(Response);
    delay = new Date().valueOf() - then;
    expect(data).toEqual(["/api/status", "/api/retry/3"]);
    expect(delay).toBeGreaterThan(500);
    await fm.kill();
    await fetch(urls.reset);
  });

  test("it prioritises user wait when retrying from the back of the queue", async () => {
    const trace_cb: fm.cb.trace = (_data) => {
      // console.log(_data.message);
    };
    const wait_cb: fm.cb.wait = () => 500;
    const fm = new FetchManager(10, 10, "sec", ["localhost:3000"], {
      wait_ms: 200,
      trace_cb,
    });

    const then = new Date().valueOf();
    const res = fm.fetch(urls.retry(3), { force_retry: 3, wait_cb });
    const res_status = new Promise((res) =>
      setTimeout(() => res(fm.fetch(urls.status))),
    );
    expect(res_status).resolves.toBeInstanceOf(Response);
    let delay = new Date().valueOf() - then;
    expect(delay).toBeGreaterThan(500);

    expect(res).resolves.toBeInstanceOf(Response);
    delay = new Date().valueOf() - then;
    expect(delay).toBeGreaterThan(1500);
    await fm.kill();
    await fetch(urls.reset);
  });

  test("it retries from the front of the queue", async () => {
    const trace_cb: fm.cb.trace = (_data) => {
      // console.log(_data);
    };
    const data: string[] = [];
    const response_cb: fm.cb.resp<"url"> = (res, req) => {
      const url = new URL(req.url);
      data.push(url.pathname);
      return res;
    };
    const fm = new FetchManager(10, 10, "sec", ["localhost:3000"], {
      wait_ms: 200,
      response_cb,
      trace_cb,
    });
    const res = fm.fetch(urls.retry(3), { force_retry: -3 });
    const res_status = fm.fetch(urls.status);
    expect(res_status).resolves.toBeInstanceOf(Response);
    expect(res).resolves.toBeInstanceOf(Response);
    expect(data).toEqual(["/api/retry/3", "/api/status"]);
    await fm.kill();
    await fetch(urls.reset);
  });

  test("it skips the queue", async () => {
    const trace_cb: fm.cb.trace = (_data) => {
      // console.log(_data);
    };
    const data: string[] = [];
    const response_cb: fm.cb.resp<"url"> = (res, req) => {
      const url = new URL(req.url);
      data.push(url.pathname);
      return res;
    };
    const fm = new FetchManager(10, 10, "sec", ["localhost:3000"], {
      response_cb,
      trace_cb,
    });
    const res = fm.fetch(urls.status);
    const res2 = fm.fetch(urls.status);
    const res3 = fm.fetch(urls.data, { skip_queue: true });
    expect(res).resolves.toBeInstanceOf(Response);
    expect(res2).resolves.toBeInstanceOf(Response);
    expect(res3).resolves.toBeInstanceOf(Response);
    expect(data).toEqual(["/api/data", "/api/status", "/api/status"]);
    await fm.kill();
  });
});
