import FetchManager from "fetch-manager";
import { test, describe, expect } from "bun:test";
const urls = {
  slow: (time: number) => `http://localhost:3000/api/slow/${time}`,
};
describe("signals", () => {
  test("it times out", async () => {
    let fm = new FetchManager(1, 1, "sec", ["localhost:3000"]);
    const controller = new AbortController();
    const { signal } = controller;
    let resp = await fm
      .fetch(urls.slow(1000), { signal }, { abort_timeout: 300 })
      .catch((err) => err.name);
    expect(resp).toBe("TimeoutError");

    const req = new Request(urls.slow(1000), { signal });
    resp = await fm.fetch(req, { abort_timeout: 300 }).catch((err) => err.name);
    expect(resp).toBe("TimeoutError");
    await fm.kill();

    fm = new FetchManager(1, 1, "sec", [
      { target_key: "localhost:3000", abort_timeout: 300 },
    ]);
    resp = await fm.fetch(urls.slow(1000)).catch((err) => err.name);
    expect(resp).toBe("TimeoutError");
    await fm.kill();

    fm = new FetchManager(1, 1, "sec", ["localhost:3000"], {
      abort_timeout: 300,
    });
    resp = await fm.fetch(urls.slow(1000)).catch((err) => err.name);
    expect(resp).toBe("TimeoutError");
    await fm.kill();
  });

  test("it aborts inflight requests", async () => {
    let trace = {} as fm.trace_data;
    const trace_cb: fm.cb.trace = (data) => (trace = data);
    const fm = new FetchManager(20, 5, "sec", ["localhost:3000"], { trace_cb });
    let controller = new AbortController();
    let signal = controller.signal;
    setTimeout(() => controller.abort(), 300);
    let resp = await fm
      .fetch(urls.slow(1000), { signal }, { abort_timeout: 500 })
      .catch((err) => err.name);
    expect(resp).toBe("AbortError");
    // expect(trace.message).toBe("assada");
    expect(trace.queue).toBe(0);
    await fm.kill();
  });

  test("it aborts queued requests", async () => {
    let count = 0;
    let aborted = false;
    let trace = {} as fm.trace_data;
    const trace_cb: fm.cb.trace = (data) => (trace = data);
    const fm = new FetchManager(20, 1, "sec", ["localhost:3000"], { trace_cb });
    const controller = new AbortController();
    const signal = controller.signal;
    signal.addEventListener("abort", () => (aborted = true));
    const response_cb: fm.cb.resp = (resp, _req) => {
      count++;
      if (count === 5) controller.abort();
      return resp.ok;
    };
    const promises = [...Array(10)].map(() =>
      fm.fetch(urls.slow(50), { signal }, { response_cb }).catch(() => false),
    );
    const five_of_ten = await Promise.all(promises);

    expect(aborted).toBe(true);
    expect(trace.queue).toBe(0);
    expect(trace.message).toContain("User aborted before fetch");
    expect(five_of_ten).toEqual([
      true,
      true,
      true,
      true,
      true,
      false,
      false,
      false,
      false,
      false,
    ]);
    await fm.kill();
  });
});
