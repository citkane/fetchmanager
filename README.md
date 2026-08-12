# FetchManager
A wrapper around native Node / Bun `fetch` that provides utility to manage:
- rates
- concurrency
- paging
- response data

<details>
<summary>## Basic usage</summary>

```ts
import FetchManager from "fetchmanager";

const time_period = "min";
const rpp_max = 200; // Maximum Requests Per Period (rpp) ie. the rate limit
const concurrency_max = 3; //Maximum active requests at any given time
const hosts: fm.host<"req">[] = [
    "foo.domain.com",
    "bar.domain.com"
    "baz.other.com"
];

const fetch_m = new FetchManager(
  rpp_max,
  concurrency_max,
  time_period,
  hosts,
).fetch;

/* Use it just like native `fetch` */
const foo = await fetch_m("https://foo.domain.com").then((res) => res.json());

/* Process response data and inform `fetch_m` of the expected return type */ 
const response_cb: fm.cb.response<"req"> = (resp, _req) => resp.json().then((data: bar_type) => data.bar);
const req = new Request("https://bar.domain.com/api", {...RequestInit...});
const bar = await fetch_m<bar_type>(req, {response_cb}));


/* Retry 503 and 429 repsonses after a period set in the response header
 * Handle non-standard RequestInit, such as Bun's `{ tls: { rejectUnauthorized: false }}` */ 
const handlers = {
    retry_cb: (resp, _req) => {
        if (resp instanceof Error) return false;
        return [503, 429].includes(resp.status);
    },
    wait_cb: (resp, _req) => {
        const ms = resp.headers.get("wait")
        return Number(ms)
    }, 
} as {
    retry_cb: fm.cb.retry<"url">;
    wait_cb: fm.cb.wait<"url">; 
}
const baz = fetch_m("http://baz.other.com", {...NonStandardInit...} as RequestInit, handlers) 

```
</details>
