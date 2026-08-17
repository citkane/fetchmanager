import FetchManager from "fetchmanager";
import { test, describe, expect, spyOn } from "bun:test";

describe("error handling", () => {
  test("it errors on bad url", async () => {
    const fm = new FetchManager(1, 1, "sec", ["localhost:3000"]);
    expect(fm.fetch("http://foobar.com")).rejects.toBeInstanceOf(Error);
    await fm.kill();
  });

  test("it throws on duplicate host", async () => {
    const fm = new FetchManager(1, 1, "sec", ["localhost:3000"]);
    function fail() {
      new FetchManager(1, 1, "sec", ["localhost:3000"]);
    }
    expect(fail).toThrow();
    await fm.kill();
  });

  test("it throws if no host given", async () => {
    function fail() {
      new FetchManager(1, 1, "sec", []);
    }
    expect(fail).toThrow();
  });

  test("it warns on duplicate host", async () => {
    const spy = spyOn(console, "warn");
    const fm = new FetchManager(1, 1, "sec", [
      "localhost:3000",
      "localhost:3000",
    ]);
    expect(spy).toHaveBeenCalled();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      "[FetchManager] localhost:3000 is defined multiple times. Options from first instance retained",
      {
        host_string: "localhost:3000",
      },
    );

    // spy.mockRestore();
    await fm.kill();
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
