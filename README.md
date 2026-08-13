# FetchManager
A wrapper around native Node / Bun `fetch` providing utility to manage:
- rate limitting
- concurrency
- paging
- response data

## Basic usage
<details>
<summary>Examples</summary>

### Initiate a Fetchmanager instance
This will act upon a unique set of hosts.

```ts
import FetchManager from "fetchmanager";

const time_period = "min";
const rpp_max = 200; // Maximum Requests Per Period (rpp) ie. the rate limit
const concurrency_max = 3; //Maximum active requests at any given time
const fetch_m = new FetchManager(rpp_max, concurrency_max, time_period, [
  "foo.domain.com",
  "bar.domain.com",
  "baz.other.com",
]).fetch;
```


### example (1)
Use it akin to native `fetch`

```ts
const foo_res = await fetch_m("https://foo.domain.com/api").catch((err) => {
  // if no response, err is `Error`, else if Response.ok === false, it is `Response`.
  if (err instanceof Error) throw err;
  console.error(err.status);
});
```

### example (2)
Process response data and inform `fetch_m` of the expected return type

```ts
const req = new Request("https://bar.domain.com/api", {/*...RequestInit...*/});

const response_cb: fm.cb.resp<"req"> = async (resp, _req) => {
  return resp.json().then((data: bar_type) => data.bar);
};

const bar = await fetch_m<bar_type["bar"]>(req, { response_cb }); // `bar` is now typed
```

### example (3)
 * a) Wait and retry 503 / 429 status's based on response headers.
 * b) Accept non-standard framework / module `RequestInit` shapes 

```ts
// Specify the type of request:
// <"url"> = { url: string; req_init?: RequestInit }, <"req"> = Request
const handlers: {
  retry_cb: fm.cb.retry<"url">;
  wait_cb: fm.cb.wait<"url">;
} = {
  retry_cb: (resp, _req) => {
    return resp instanceof Error ? false : [503, 429].includes(resp.status);
  },
  wait_cb: (resp, _req) => {
    if (resp instanceof Error) return 0; // We have already filtered out `Errors` in retry_cb, but TS doesn't know that.
    const wait_ms = resp.headers.get("Retry-After") || "500";
    return Number(wait_ms);
  },
};

const baz = await fetch_m(
  "https://baz.other.com/api",
  { tls: { rejectUnauthorized: false } } as RequestInit, //You have to fool TS typing
  handlers,
);
```

</details>

## Core concepts
FetchManager is a class instance acting on a unique set of one or more given hosts. Under the hood, it manages a request queue that has a configurable heartbeat.
Many class instances can be created for unique sets of hosts. They will act independantly and in parallel, but hosts cannot overlap - 
ie. a host cannot be repeated in multiple instances.

If and when rate / concurrency limits are reached for an instance, it's queue is paused until the limits are once again within allowances.
Logic such as paging and adaptive retrying is managed by user provided callback handlers:
- `retry_cb`: answers "*should I retry this failed request?*" with a boolean response,
- `wait_cb`: answers "*how long to wait before retrying?*" with a number in ms,
- `pager_cb`: answers "*is there more data?*" with nullish or a new request for true,
- `response_cb`: manipulates the response payload into a desired shape before returning it.
- `trace_cb`: provides diagnostic data about the state of the queue.

Handlers (excepting trace) are injected with the `Response | Error` as well as a clone of the `Request`.
The pager_cb is injected with an additional (optional) `collect` function to facilitate merging the final data return. 

Handlers (excepting pager) can be set at 3 cascading levels of priority:
1) per individual request
2) per individual host
3) at class instantiation for the whole host set.

Behaviour can thus be set globally and overidden granularly. Paging is set on a per request basis.

Fetchmanger is not very opinionated. It is up to the user to build a re-usable kit of callback handlers to manage their application logic.

Each request has further utility options:
- prioritise a request to the front of the queue
- retry a request x number of times (independent of retry_cb)
- prioritise a retry to the front / back of the queue (independent of retry_cb)

Rate and concurrency rules are set at class instantiation. Further default options can be overidden here:
- heartbeat: the rate at which the queue is processed (default 20ms)
- default retry wait (independant of wait_cb, default 500ms)

## Paging
<details>
<summary>Example</summary>
... Continued from previous example

```ts
const pager_cb: fm.cb.pager<"req"> = async (resp, req, collect) => {
  const { next, data } = (await resp.json()) as bar_type;
  if (!next) return;
  collect(data); //optional
  const url = new URL(req.url);
  url.searchParams.set("continue", next.continue);
  url.searchParams.set("sroffset", String(next.sroffset));
  return new Request(url, req);
};

const req = new Request("https://bar.domain.com/api/paged", {/*...RequestInit...*/});
const all_data = await fetch_m<bar_type["data"][]>(req, pager_cb);
```

`pager_cb` will cause `fetch_m` to always return an `Array`.

In the above, we use `collect`. It is slightly opinionated. If `data` is `any[]`, then it will merge the paged results so that `all_data` is also `any[]`
This behaviour can be overidden with `collect(data, false)` in which case `all_data` will be `any[][]`

Usage of `collect` is optional. If not used, `all_data` will be one of:
- If `response_cb` is set: `Awaited<ReturnType<response_cb>>[]` else
- `Response[]` 

</details>

## Trace
The `trace_cb` is of the shape:
```ts
(data: fm.trace_data) => void
```

It is handled on the next tick after the queue heartbeat

<details>
<summary>trace_data</summary>

```ts
 
type trace_data = {
    message?: string; // Error messaging
    paused?: number; // For how long is the queue paused in ms
    stopped?: "queue empty" | "max concurrency"; // If the queue is not running, why?
    rpp: number; // the current Request Per Period rate
    rpp_max: number; // the max allowed rpp
    rpp_period: period; // "sec" | "min" | "hr" | "day"
    concurrency: number; // number of concurrent requests
    max_concurrency: number; // max allowed concurrency
    queue: number; // length of the queue
    skip_queue: boolean; // is the current request prioritised?
    force_retry: number; // How many times to retry left? (independent of retry_cb)
    host_string: string; // host of current request
    href: string; //href of current request
};

```
</details>

## Options and overloads

<details>
<summary>Class initialiser</summary>

```ts
const fetch_m = new FetchManager({
    req_max_per_period: number,     // The rate limit
    req_max_concurrent: number,     // Maximum concurrency
    rpp_period_def: fm.period,      // The period of the rate limit, "sec" | "min" | "hr" | "day"
    unique_hosts: [/*... See below ...*/],
    options?: {
        wait_ms?: number,           // Override the default retry wait in ms
        heartbeat?: number,         // Override the default queue heartbeat in ms
        retry_cb?: fm.cb.retry<K>,  // Handlers are fallen back on as priority (3)
        wait_cb?: fm.cb.wait<K>,
        trace_cb?: fm.cb.trace,
    },
}).fetch
```

</details>

<details>
<summary>Host definitions</summary>

A host is [as per specification](https://developer.mozilla.org/en-US/docs/Web/API/URL/host), the string returned by `URL.host`

Host sets are defined as an Array in two, or a mix of two forms as below:
```ts
[
    "foo.domain.com",
    "bar.domain.com"
]
```

In this form, fallback handlers are specified for "bar.domain.com"
```ts
[
    "foo.domain.com",
    {
        host_string: "bar.domain.com",
        response_cb?: fm.cb.resp<K>,    // Handlers are fallen back on as priority (2)
        retry_cb?: fm.cb.retry<K>,
        wait_cb?: fm.cb.wait<K>,
        trace_cb?: fm.cb.trace,
    }
]
```

</details>

<details>
<summary>Fetch</summary>

In order to cater for non-standard `RequestInit` forms, a request is defined as one of two forms:
- <`Request`> or
- <`string`, `{...}` as RequestInit>

`fetch_m(Request)` is thus effectively the same as `fetch_m("url", {...} as RequestInit)`, except you have the ability to pass non-standard options.
For convenience this overload will be notated below as `<fm.req>`

The anatomy of a fetch is thus ordered as follows:
```ts
fetch_m(<fm.req>, options?, pager_cb?)
```

This translates to a number of overloaded forms:
```ts
fetch_m("url")
fetch_m("url", pager_cb)
fetch_m("url", {...options})
fetch_m("url", {...options}, pager_cb)
fetch_m("url", {...} as RequestInit)
fetch_m("url", {...} as RequestInit, {...options})
fetch_m("url", {...} as RequestInit, {...options}, pager_cb)
fetch_m({...Request})
fetch_m({...Request}, pager_cb)
fetch_m({...Request}, {...options})
fetch_m({...Request}, {...options}, pager_cb)
```

### Options
```ts
{
    skip_queue?: boolean,           // Send this request to the front of the queue
    force_retry?: number,           // Retry this request x amount of times. -x to retry from the queue front 
    response_cb?: fm.cb.resp<K>,    // Handlers here are first priority (1)
    retry_cb?: fm.cb.retry<K>,
    wait_cb?: fm.cb.wait<K>,
    trace_cb?: fm.cb.trace,
}

```

</details>
