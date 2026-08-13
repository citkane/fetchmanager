# FetchManager
A wrapper around native Node / Bun `fetch` that provides utility to manage:
- rates
- concurrency
- paging
- response data

## Basic usage
<details>
<summary>Examples</summary>

```ts
import FetchManager from "fetchmanager";

/* Set up a FetchManager instance */
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

/* example (1)
 * Use it like native `fetch` */
const foo_res = await fetch_m("https://foo.domain.com").catch(err => {
    // if !Response.ok, err is Response, else if no Response - it is Error
    if (err instanceof Error) throw err;
    console.error(err.status)
});

/* example (2) 
 * Process response data and inform `fetch_m` of the expected return type */ 
const response_cb: fm.cb.response<"req"> = (resp, _req) => resp.json().then((data: bar_type) => data.bar);
const req = new Request("https://bar.domain.com/api", {...RequestInit...});
const bar = await fetch_m<bar_type>(req, {response_cb}));


/* example (3)
 * Retry 503 and 429 repsonses after a period set in the response header.
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
const baz = await fetch_m("http://baz.other.com", {...NonStandardInit...} as RequestInit, handlers) 

```
</details>

## Basic concepts
FetchManager provides a class instance that acts on a unique set of one or more given hosts. Under the hood, it manages a request queue on a configurable heartbeat.
Many class instances can be created for unique sets of hosts. They will act independantly, but hosts cannot overlap - ie. a host cannot be repeated in multiple sets.

If and when rate / concurrency limits are reached, the queue is paused until the limits are once again within allowances.
User logic, such as paging and adaptive rate limiting is managed by user provided callback handlers:
- retry_cb: answers "*should I retry this failed request?*" with a boolean response,
- wait_cb: answers "*how long to wait before retrying?*" with a number in ms,
- pager_cb: answers "*is there more data?*" with `false` or a new `Request`,
- response_cb: manipulates the response payload in the desired shape before returning it.
- trace_cb: provides rich data about the state of queue for logging purposes.

Handlers (excepting trace) are injected with the `Response` as well as a clone of the `Request` to query for application logic.
The pager_cb is injected with an additional (optional) `collect` function to facilitate a clean final data return. 

Handlers (excepting pager) can be set at 3 cascading levels of priority:
1) per individual request
2) per individual host
3) at class instantiation for the whole host set.
Behaviour can thus be set globally and overidden granularly.
Paging is set on a per request basis.

Each request has additional options to further manage:
- prioritise to front of queue
- retry x times (independent of retry_cb, where the user can manage their own logic)
- retry priority (front / back of queue)

Rate and concurrency rules are set at class instantiation, and further default options can be overidden here:
- heartbeat: the rate at which the queue is processed
- default retry wait (independant of wait_cb, where the user can manage their own logic)


<details>
<summary>Examples</summary>


</details>



