# FetchManager
A zero dependency wrapper around native Node / Bun `fetch` providing utility to manage:
- rate limitting
- concurrency
- paging
- response data

- [Basic Usage](#basic-usage)
- [Paging](#paging)
- [Trace](#trace)
- [Options and overloads](#options-and-overloads)
- [Instance destruction](#instance-destruction)
- [Installation](#installation)
- [More Resources](#more-resources)
- [What about Deno?](#what-about-deno?)
- [What about the browser?](#what-about-the-browser?)
- [Why another fetch library?](#why-another-fetch-library?)
- [Similar libraries](#similar-libraries)

## Basic usage

### Initiate a Fetchmanager instance
This will act upon a unique set of hosts.

```ts
import FetchManager from "fetchmanager";

const time_period = "min";
const rpp_max = 200;        // Maximum Requests Per Period (rpp) ie. the rate limit
const concurrency_max = 3;  // Maximum active requests at any given time
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
    /* `err` is one of:
     * a) if no response; `Error`, else 
     * b) if `!Response.ok`; `Response`. */
    if (err instanceof Error) throw err;
    console.error(err.status);
});
```

### example (2)
Pre-process response data and inform `fetch_m` of the expected return type

```ts
const response_cb: fm.cb.resp = async (resp, _req) => {
  return resp.json().then((data: bar_type) => data.bar);
};
const req = new Request("https://bar.domain.com/api")
const bar = await fetch_m<bar_type["bar"]>(req, { response_cb }); // `bar` is now typed
```

### example (3)
 * a) Wait and retry 503 / 429 status's based on response headers.
 * b) Accept non-standard framework / module `RequestInit` shapes 

```ts
const handlers: {
  retry_cb: fm.cb.retry;
  wait_cb: fm.cb.wait;
} = {
  retry_cb: (resp, _req) => {
    return resp instanceof Error ? false : [503, 429].includes(resp.status);
  },
  wait_cb: (resp, _req) => {
    /* We have already filtered out `Error`s in retry_cb,
     * but the TS pre-processor doesn't know that. */
    if (resp instanceof Error) return 0; 
    const wait_ms = resp.headers.get("Retry-After") || "500";
    return Number(wait_ms);
  },
};

const baz = await fetch_m(
    "https://baz.other.com/api",
    /* If the global `RequestInit` type definition is not compliant, then you can fool TS typing
     * Ensure that your global native `fetch` is capable of accepting the non-standard shape */
    { tls: { rejectUnauthorized: false } } as RequestInit, 
    handlers,
);
```

## Core concepts
FetchManager provides class instances acting on a unique set of one or more given [hosts](https://developer.mozilla.org/en-US/docs/Web/API/URL/host).
Under the hood, it manages a (configurable) heartbeat driven request queue for each instance.
Many instances can be created for unique sets of hosts. They will act independantly and in parallel, but hosts cannot overlap - 
ie. a host cannot be repeated in multiple instances. See later documentation on `FetchManager.stop` and `FetchManager.kill` for re-defining hosts.

If and when rate / concurrency limits are reached for an instance, it's queue is paused until the limits are once again within allowances.
Logic such as paging and adaptive retry strategies are managed by user provided callback handlers:
- `retry_cb`: answers "*should I retry this failed request?*" with a boolean response,
- `wait_cb`: answers "*how long to wait before retrying?*" with a number in ms,
- `pager_cb`: answers "*is there more data?*" with nullish for false or a new request for true,
- `response_cb`: manipulates the response payload into a desired data shape before resolving it.
- `trace_cb`: provides diagnostic data about the state of the queue.

Handlers (excepting trace) are injected with the `Response | Error` as well as the request in it's given shape: (clone of `Request` or `{ url: string; req_init?: RequestInit }`).
The pager_cb is injected with an additional (optional) `collect` function to facilitate flattening the final data return. 

Handlers (excepting pager) can be set at 3 cascading levels of priority:
1) per individual request
2) at class instantiation per individual host
3) at class instantiation for the whole host set.

Behaviour can thus be set globally, and overidden granularly. Paging is set on a per request basis.
Fetchmanger is not very opinionated. It is up to the user to build a re-usable kit of callback handlers to manage their application logic.

Each request has further utility options:
- prioritise a request to the front of the queue
- retry a request x number of times (independent of retry_cb)
- prioritise request retries to the front / back of the queue (independent of retry_cb)

Rate and concurrency rules are set at class instantiation. Further default options can be overidden here:
- heartbeat: the rate at which the queue is processed (default 20ms)
- default retry wait (independant of wait_cb, default 500ms)

## Paging
<details>
<summary>Example</summary>
... Continued from previous example

```ts
/* We inform the callback of the request type, `<"req" | "url">`
 * so that the `req` parameter type is disambiguated. */ 
const pager_cb: fm.cb.pager<"req"> = async (resp, req, collect) => {
  const { next, data } = (await resp.json()) as bar_type;
  collect(data);                        // optional - overrides `response_cb` and flattens the resolved result
  if (!next) return;                    // return nullish if no more data is expected

  const url = new URL(req.url);
  url.searchParams.set("next", next);
  return new Request(url, req);         // return a request for more data
};

const req = new Request("https://bar.domain.com/api/paged")
const all_data = await fetch_m<bar_type["data"][]>(req, pager_cb);
```

`pager_cb` will cause `fetch_m` to always return an `Array`.

In the above example, we used the `collect` utility function. It is slightly opinionated. If `data` is `any[]`, then it will flatten the paged results so that `all_data` is also `any[]`
This behaviour can be overidden with `collect(data, false)` in which case `all_data` will be `any[][]`

Usage of `collect` is optional. If not used, `all_data` will be one of:
- If `response_cb` is defined: `Awaited<ReturnType<response_cb>>[]` else
- `Response[]` 

</details>

## Trace
The `trace_cb` is of the shape:
```ts
(data: fm.trace_data) => void
```

It is handled on the tick after the queue heartbeat, ie. you will need to use `setTimeout` to capture the latest `trace_data` after a fetch resolves
```ts
const trace_cb: fm.cb.trace = (trace_data) => setTimeout(() => console.debug(trace_data.rpp));
```

<details>
<summary>trace_data</summary>

```ts
 
type trace_data = {
    message?: string;                               // Error messaging
    paused?: number;                                // For how long is the queue paused in ms
    stopped?: "queue empty" | "max concurrency";    // If the queue is not running, why?
    rpp: number;                                    // the Request Per Period rate
    rpp_max: number;                                // the max allowed rpp
    rpp_period: period;                             // "sec" | "min" | "hr" | "day"
    concurrency: number;                            // number of concurrent requests
    max_concurrency: number;                        // max allowed concurrency
    queue: number;                                  // length of the queue
    skip_queue: boolean;                            // is the request prioritised?
    force_retry: number;                            // How many times to retry left? (independent of retry_cb)
    host_string: string;                            // host of the request
    href: string;                                   // href of the request
};

```
</details>

## Options and overloads

<details>
<summary>Class initialiser</summary>

```ts
const fetch_m = new FetchManager({
    req_max_per_period: number,             // The rate limit
    req_max_concurrent: number,             // Maximum concurrency
    rpp_period_def: fm.period,              // The period of the rate limit, "sec" | "min" | "hr" | "day"
    unique_hosts: [/*... See below ...*/],
    options?: {
        wait_ms?: number,                   // Override the default retry wait in ms
        heartbeat?: number,                 // Override the default queue heartbeat in ms
    /* Handlers defined here are 
     * fallen back on as priority (3) */
        retry_cb?: fm.cb.retry,             
        wait_cb?: fm.cb.wait,
        trace_cb?: fm.cb.trace,
    },
}).fetch
```

</details>

<details>
<summary>Host set definitions</summary>

A host is [as per specification](https://developer.mozilla.org/en-US/docs/Web/API/URL/host), the string returned by `URL.host`

Host sets are defined as an Array in two, or a mix of two shape as below:
```ts
[
    "foo.domain.com",
    "bar.domain.com"
]
```

In the shape below, fallback handlers are specified for "bar.domain.com"
```ts
[
    "foo.domain.com",
    {
        host_string: "bar.domain.com",
    /* Handlers defined here are fallen back on as priority (2) */
        response_cb?: fm.cb.resp,       
        retry_cb?: fm.cb.retry,
        wait_cb?: fm.cb.wait,
        trace_cb?: fm.cb.trace,
    }
]
```

</details>

<details>
<summary>Fetch</summary>

In order to cater for non-standard `RequestInit` forms, a request can be defined as one of two shapes:
- <`Request`> or
- <`string`, `{...}` as RequestInit>

`fetch_m(Request)` is effectively the same as `fetch_m("url", {...} as RequestInit)`, except you have the ability to pass non-standard options which `new Request` would otherwise reject.
For convenience this overload will be notated below as `<fm.req>`

The anatomy of a fetch is thus ordered as follows:
```ts
fetch_m(<fm.req>, options?, pager_cb?)
```

This translates to a number of overloaded shapes:
```ts
fetch_m("url")
fetch_m("url", pager_cb)
fetch_m("url", {...options})
fetch_m("url", {...options}, pager_cb)
fetch_m("url", {...} as RequestInit)
fetch_m("url", {...} as RequestInit, {...options})
fetch_m("url", {...} as RequestInit, {...options}, pager_cb)
fetch_m(Request)
fetch_m(Request, pager_cb)
fetch_m(Request, {...options})
fetch_m(Request, {...options}, pager_cb)
```

### Options
```ts
{
    skip_queue?: boolean,           // Send this request to the front of the queue
    force_retry?: number,           // Retry this request x amount of times. -x to retry from the queue front 
/* Handlers defined here 
 * are first priority (1) */
    response_cb?: fm.cb.resp,              
    retry_cb?: fm.cb.retry,         // retry_cb always retries from the front of the queue
    wait_cb?: fm.cb.wait,
    trace_cb?: fm.cb.trace,
}

```

</details>

## Instance destruction
It is possible to destroy an instance and then re-use the hosts that were wrapped. Two instance methods are provided:
### `FetchManager.kill`
This will immediately stop processing the queue and all awaiting requests will be rejected with the message "Host group was killed".
```ts
const {fetch: fetch_m, kill: kill_m} = new FetchManager(..., hosts: [...]);
/* Application does stuff with fetch_m */
await kill_m();
/* Hosts can now be re-used in new instances */
```

### `FetchManager.stop`
This will wait for the queue to drain before killing it. It is up to the user to stop feeding it, otherwise it will never drain.
```ts
const {fetch: fetch_m, stop: stop_m} = new FetchManager(..., hosts: [...]);
/* Application does stuff with fetch_m */
await stop_m();
/* Hosts can now be re-used in new instances */
```

## Installation
```bash
bun install https://github.com/citkane/fetchmanager
npm i https://github.com/citkane/fetchmanager
```

## More resources
### Types
FetchManager types are under the `fm` namespace. They are annotated with examples, so your IDE should give you helpful documentation.
### LibFetch
A library of off the shelf re-usable callbacks:
```ts
import LibFetch from "fetchmanager/lib";
const lib_fetch = new LibFetch();
const wait_cb = lib_fetch.wait.backoff_factory()
const retry_cb = lib_fetch.retry...
...etc
```

### Tests
Tests are made for, and run with the Bun framework. You can examine these to better understand the expectations for various aspects of the library.

### Demo
Try a rather nifty WikiData explorer!
```bash
node ./demo/wikidata.js
```

```bash
bun ./demo/wikidata/

```

## What about Deno?
I don't use Deno, so I haven't tried it there. It will probably work.

## What about the browser?
I haven't needed that yet. If you build the TS with a browser target, it will probably work.

## Why another `fetch` library?
Because my attention span is limited. While working on an application that aggragates data from a number of API's with different rate rules and paging logic,
I wanted something specific with zero dependencies that is as close to the native `fetch` syntax as possible. The result is this library.
It has dramatically reduced my app's boilerplating.

## Similar libraries:
- [axios-rate-limit](https://www.npmjs.com/package/axios-rate-limit)
- [node-rate-limiter-flexible](https://github.com/animir/node-rate-limiter-flexible/wiki/Overall-example#third-party-api-crawler-bot-rate-limiting)
- [limiter](https://www.npmjs.com/package/limiter)
