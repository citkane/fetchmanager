import FetchManager from "fetch-manager";
import { test, describe, expect, spyOn } from "bun:test";

describe("error handling", () => {
  test("it errors on bad url", async () => {
    const fm = new FetchManager(1, 1, "sec", ["localhost:3000"]);
    expect(fm.fetch<string>("http://foobar.com")).rejects.toThrowError(
      "No target found",
    );
    await fm.kill();
  });

  test("it errors on overlapping target definition", async () => {
    const fm = new FetchManager(1, 1, "sec", ["localhost:3000", "foo.com"]);
    function fail() {
      new FetchManager(1, 1, "sec", ["localhost:3000"]);
    }
    expect(fail).toThrowError("Targets already defined in other groups:");
    await fm.kill();
  });

  test("it warns on duplicate target group", async () => {
    const spy = spyOn(console, "warn");
    const fm = new FetchManager(1, 1, "sec", ["localhost:3000"]);
    new FetchManager(1, 1, "sec", ["localhost:3000"]);
    expect(spy).toHaveBeenCalled();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining(
        "Got a duplicate target group. Previous options were retained",
      ),
      {
        group: ["localhost:3000"],
      },
    );

    spy.mockRestore();
    await fm.kill();
  });

  test("it warns on duplicate target", async () => {
    const spy = spyOn(console, "warn");
    const fm = new FetchManager(1, 1, "sec", [
      "localhost:4000",
      { target_key: "localhost:3000", retry_cb: () => false },
      { target_key: "localhost:3000", trace_cb: () => {} },
    ]);
    expect(spy).toHaveBeenCalled();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("Duplicate targets were found"),
      {
        rejected: [
          {
            target_key: "localhost:3000",
            trace_cb: expect.any(Function),
          },
        ],
        used: [
          "localhost:4000",
          {
            retry_cb: expect.any(Function),
            target_key: "localhost:3000",
          },
        ],
      },
    );

    spy.mockRestore();
    await fm.kill();
  });

  test("it errors if no host given", async () => {
    function fail() {
      new FetchManager(1, 1, "sec", []);
    }
    expect(fail).toThrowError("No targets given in constructor");
  });

  test("it errors on bad buckets", async () => {
    const fm = new FetchManager(1, 1, "sec", ["localhost:3000"]);
    const bucket = FetchManager.bucket.get("localhost:3000")!;
    bucket.period = "min";
    let fail = () => FetchManager.bucket.set("localhost:3000", bucket);
    expect(fail).toThrowError("periods must match");
    bucket.period = "sec";
    bucket.max_rpp = 2;
    fail = () => FetchManager.bucket.set("localhost:3000", bucket);
    expect(fail).toThrowError("max_rpp must match");
    bucket.max_rpp = 1;
    bucket.max_concurrency = 2;
    fail = () => FetchManager.bucket.set("localhost:3000", bucket);
    expect(fail).toThrowError("max_concurrency must match");
    await fm.kill();
  });
});
