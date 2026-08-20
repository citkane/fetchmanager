# fetch-man (Fetch Manager)
A zero dependency wrapper around native Javascript `fetch` providing management of:
- rate limitting
- concurrency
- paging
- response data

Tested for Node and Bun.

- [Basic Usage](#basic-usage)
- [Core concepts](#core-concepts)
- [Paging](#paging)
- [Trace](#trace)
- [Options and overloads](#options-and-overloads)
- [Distributed architectures](#distributed-architectures)
- [Instance destruction](#instance-destruction)
- [Installation](#installation)
- [More Resources](#more-resources)
- [Demo](#demo)
- [What about Deno?](#what-about-deno)
- [What about the browser?](#what-about-the-browser)
- [Why another fetch library?](#why-another-fetch-library)
- [Similar libraries](#similar-libraries)

## Basic usage
[top](#fetchmanager)
### Initiate a Fetch Manager instance
This will act upon a unique set of targets.

```ts
import FetchManager from "fetch-man";

const time_period = "min";
const rpp_max = 200;        // Maximum Requests Per Period (rpp) ie. the rate limit
const concurrency_max = 3;  // Maximum active requests at any given time
const fm = new FetchManager(rpp_max, concurrency_max, time_period, [
  "foo.domain.com",
  "bar.domain.com",
  "baz.domain.com/api",      // Targets can be "URL.host" or "URL.host + URL.pathname" 
]);
```


### example (1)
Use it akin to native `fetch`

```ts
const foo_res = await fm.fetch("https://foo.domain.com/api").catch((err) => {
    /* `err` is one of: */
    if (err instanceof Error) throw err;    // if no `Response` then `Error`
    console.error(err.status);              // if no `Response.ok` then `Response`
});
```

### example (2)
Pre-process response data and inform `fm.fetch` of the expected return type

```ts
const response_cb: fm.cb.resp = async (resp, _req) => {
  return resp.json().then((data: bar_t) => data.bar);
};
const req = new Request("https://bar.domain.com/api")
const bar = await fm.fetch<bar_t["bar"]>(req, { response_cb }); // `bar` is now typed
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

const baz = await fm.fetch(
    "https://baz.domain.com/api/endpoint",
    /* If the global `RequestInit` type definition is not compliant, then you can fool TS typing
     * Ensure that your global `fetch` is capable of accepting the non-standard shape */
    { tls: { rejectUnauthorized: false } } as RequestInit, 
    handlers,
);
```

## Core concepts
[top](#fetchmanager)

Fetch Manager provides class instances acting on a unique set of one or more given targets. A target is one of:
- [host](https://developer.mozilla.org/en-US/docs/Web/API/URL/host)
- host + [pathname](https://developer.mozilla.org/en-US/docs/Web/API/URL/pathname)

Under the hood it manages a request queue driven by a (configurable) heartbeat for each instance.
Many instances can be created which will act independantly and in parallel,
but targets cannot overlap on a thread, and should not overlap across a distributed system - 
ie. a target must not be repeated in multiple instances. If it is, then rate calculations will be inacurate.
See later documentation on:
- `FetchManager.stop` and `FetchManager.kill` methods for re-defining targets.
- `FetchManager.bucket.get` and `FetchManager.bucket.set` methods for orchestration.

Caching and orchestration frameworks are outside the scope of this library, and left to the user to implement.

If and when rate / concurrency limits are reached for an instance, it's queue is paused until the limits are once again within allowances.
Logic such as paging and adaptive retry strategies are managed by user provided callback handlers:
- `retry_cb`: answers "*should I retry this failed request?*" with a boolean response,
- `wait_cb`: answers "*for how long to pause the queue?*" with a number in ms,
- `pager_cb`: answers "*is there more data?*" with nullish for false or a new request for true,
- `response_cb`: manipulates the response payload into a desired data shape before resolving it.
- `trace_cb`: provides diagnostic data about the state of the queue.

Handlers (excepting trace) are injected with the `Response | Error` as well as the request in it's given shape: (see the `fm.req` type).
The pager_cb is injected with an additional (optional) `collect` function to facilitate flattening the final data return. 

Handlers (excepting pager) can be set at 3 cascading levels of priority:
1) per individual request
2) at class instantiation per individual target
3) at class instantiation for the whole target set.

Behaviour can thus be set globally, and overidden granularly. Paging is set on a per request basis.
Fetch Manger is not very opinionated. It is up to the user to build a re-usable kit of callback handlers to manage their application logic.

Each request has further utility options:
- prioritise a request to the front of the queue
- retry a request x number of times (independent of retry_cb)
- prioritise request retries to the front / back of the queue (independent of retry_cb)

Rate and concurrency rules are set at class instantiation. Further default options can be overidden here:
- heartbeat: the rate at which the queue is processed (default 20ms)
- default retry wait (independant of wait_cb, default 500ms)

## Paging
[top](#fetchmanager)

... Continued from previous example

```ts
/* We inform the callback of the request shape, `<"req" | "url">`
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

In the above example, we used the `collect` utility function. It is slightly opinionated. If `data` is `any[]`,
then it will flatten the paged results so that `all_data` is also `any[]`.
This behaviour can be overidden with `collect(data, false)` in which case `all_data` will be `any[][]`

Usage of `collect` is optional. If not used, `all_data` will be one of:
- If `response_cb` is defined: `Awaited<ReturnType<response_cb>>[]` else
- `Response[]` 


## Trace
[top](#fetchmanager)

If defined, the trace callback will be executed at every heartbeat while the queue is not paused or empty, so be mindful of the resources it consumes.

example:
Log the amount of request tokens remaining for the period, else a message indicating why the queue is stopped.
```ts
const trace_cb: fm.cb.trace = (trace_data) => console.debug(trace_data.message || trace_data.tokens);
```

<details>
<summary>trace_data details</summary>

```ts
 
type trace_data = {
    message?: string;                               // Information about the queue state
    paused?: number;                                // For how many ms is the queue paused
    tokens: number;                                 // How many request tokens remain for the period
    max_rpp: number;                                // The maximum amount of requests allowed for the period
    period: fm.period;                              // "sec" | "min" | "hr" | "day"
    concurrency: number;                            // How many requests are currently active
    max_concurrency: number;                        // Maximum concurrent requests allowed
    queue: number;                                  // The length of the request queue
    skip_queue: boolean;                            // Is the active request skipping the queue
    force_retry: number;                            // The amount of retries remaining for the request
    target_key: string;                             // The key of the requests limiter bucket
    href: string;                                   // The href of the current request
    time: number;                                   // Unix Epoch (ms)
};

```
</details>

## Options and overloads
[top](#fetchmanager)

### Class initialiser
```ts
const fm = new FetchManager({
    req_max_per_period: number,             // The rate limit
    req_max_concurrent: number,             // Maximum concurrency
    rpp_period_def: fm.period,              // The period of the rate limit, "sec" | "min" | "hr" | "day"
    targets: [/*... See below ...*/],
    options?: {
        wait_ms?: number,                   // Override the default (500) retry wait in ms
        heartbeat?: number,                 // Override the default (20) queue heartbeat in ms
    /* Handlers defined here are 
     * fallen back on as priority (3) */
        retry_cb?: fm.cb.retry,             
        wait_cb?: fm.cb.wait,
        trace_cb?: fm.cb.trace,
    },
})
```


### Target definitions

A host is [as per specification](https://developer.mozilla.org/en-US/docs/Web/API/URL/host), the string returned by `URL.host`
A pathname is [as per specification](https://developer.mozilla.org/en-US/docs/Web/API/URL/pathname), the string returned by `URL.pathname`

A target is one of two forms:
- host
- host + pathname

A request url is matched against targets on a `startsWith` basis, so if a target is "foo.com/api" then
- "https://foo.com/api/bar" will hit, but
- "https://foo.com/bar" will miss

Target sets are defined as an Array in two, or a mix of two shape as below:
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

It is important that targets are only defined once across all instances. In a single thread environment,
errors will be thrown - but maintainers of distributed systems should be mindful of the following scenario when orchestrating:

instance_1 target defined as:
```ts
["foo.com"]
```
This will catch all API endpoints for foo.com, but it may have endpoints with different rate limits, so we do:

instance_2 target defined as:
```ts
["foo.com/api/special"]    
```
Now calling `instance_1.fetch("https://foo.com/api/special")` is an error, because even though `instance_1` *can* catch it, it's limit rules are implemented on `instance_2`.
In a single threaded environment, this request will throw an error.

### Fetch
In order to cater for non-standard `RequestInit` forms, a request can be defined as one of two shapes:
- <`Request`> or
- <`string`, `{...}` as RequestInit>

`fm.fetch(Request)` is effectively the same as `fm.fetch("url", {...} as RequestInit)`, except you have the ability to pass non-standard options which `new Request` would otherwise reject.
For convenience this overload will be notated below as `<fm.req>`

The anatomy of a fetch is thus ordered as follows:
```ts
fm.fetch<optional>(<fm.req>, options?, pager_cb?)
```

This translates to a number of overloaded shapes:
```ts
fm.fetch("url")
fm.fetch("url", pager_cb)
fm.fetch("url", {...options})
fm.fetch("url", {...options}, pager_cb)
fm.fetch("url", {...} as RequestInit)
fm.fetch("url", {...} as RequestInit, {...options})
fm.fetch("url", {...} as RequestInit, {...options}, pager_cb)
fm.fetch(Request)
fm.fetch(Request, pager_cb)
fm.fetch(Request, {...options})
fm.fetch(Request, {...options}, pager_cb)
```

### Fetch user options
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


## Advanced usage
[top](#fetchmanager)

The Fetch Manager `fetch` method has some extra options to control queue priority.
- `skip_queue` pushes the request to the front of the queue
- `force_retry` forces a failed request to retry x number of times.

### skip_queue
```ts
const normal = fm.fetch("http://foo.com/api/normal")
const important = fm.fetch("http://foo.com/api/important", {skip_queue: true})
```
`important` will now be fetched before `normal`

### force_retry
This option is by nature quirky and opinionated
```ts
const buggy_endpoint = fm.fetch("http://foo.com/api/buggy", {force_retry: 5})
const important_stuff = Promise.all([...Array(10)].map(() => fm.fetch("https://foo.com/api/stuff")))
```

If `buggy_endpoint` fails for any reason, it will be re-tried for up to 5 times from the back of the queue.
All of `important_stuff` will thus be requested before `buggy_endpoint` retries.
There are some quirks to this behaviour:
- If the default retry wait is set to 500ms, `important_stuff` will proceed immediately and not wait on the buggy failure.
- If `important_stuff` consumes 300ms to make it's requests, then `buggy_endpoint` will wait the remaining 200ms before retrying.
- if the user has provided `wait_cb`, and it returns eg. 1000ms (maybe a rate limit is being imposed) - then the whole queue, including `important_stuff`, will wait for 1000ms

We can also do the inverse, and prioritise request retries to the front of the queue.
```ts
const buggy_important = fm.fetch("http://foo.com/api/buggy", {force_retry: -5})
const normal_stuff = Promise.all([...Array(10)].map(() => fm.fetch("https://foo.com/api/stuff")))
```

Note the negative (-5). `buggy_important` will now retry up to five times from the front of the queue before `normal_stuff` is requested.
If the buggy endpoint takes longer to respond (or error) than the queue pause time, then `normal_stuff` will fill in the gap with requests.

Consider `force_retry` as an override to prioritise / de-prioritise a single request. A user provided `retry_cb` will be by-passed until all the `force_retry` counts have been depleted.

## Distributed architectures
[top](#fetchmanager)

In a single thread, Fetch Manager will error and warn on conflicts between instances.
In a distributed system, rates and limits will have to be orchestrated at a higher level.

Fetch Manager does not in and of itself provide orchestration tooling, but it does expose helpers to provide the needed data.
A bucket contains the limits and current rates for a target group
- `FetchManager.bucket.get(uid_or_target)`          - Get a bucket
- `FetchManager.bucket.set(uid_or_target, bucket)`  - Set a bucket
- `fm.uid`                                          - Instance uid (Md5 hash of target keys sorted longest to shortest) 
- `FetchManager.targets`                            - Static map of uid keyed target groups

A naive, illustrative pseudo-example could look like this:
```ts
const uid = fm.uid;
const bucket = FetchManager.bucket.get(uid)
your_orchestration.publish("update", uid, bucket)

const uids = Object.keys(FetchManager.targets)
uids.forEach(uid => {
    const bucket = FetchManager.bucket.get(uid)
    your_orchestration.publish("update", uid, bucket)
})
```
```ts
your_orchestration.on("update", (uid: string, bucket: fm.bucket) => {
    if(!bucket.time) return; //bucket was created, but no requests have been made

    const ex_bucket = FetchManager.bucket.get(uid);
    bucket.tokens = Math.min(bucket.tokens, ex_bucket.tokens)
    bucket.concurrency = Math.max(bucket.concurrency, ex_bucket.concurrency)
    FetchManager.bucket.set(uid, bucket)
)
```

Buckets are of the shape:
```ts

  type bucket = {
    uid:string,                 // (immutable) The uid of the group to which this bucket belongs
    tokens: number;             // How many requests remain for the period
    concurrency: number;        // How many requests are active
    period: period;             // (immutable) "sec" | "min" | "hr" | "day"
    max_rpp: number;            // (immutable) The maximum requests per period
    max_concurrency: number;    // (immutable) The maximum concurrent requests allowed
    time: number;               // (not editable) The last update epoch in ms
  };
```

Once a bucket is set, only `tokens` and `concurrency` can be updated. It is up to the user to validate:
- That new values are less favourable than the existing values (the local limiter will be adjusting them favourably)
- That timestamps are within tolerance
- That new buckets are created with the same limits across the entire system.

If limit settings across a distributed system differ, then rate calculations will be corrupted.

## Instance destruction
[top](#fetchmanager)

It is possible to destroy an instance and then re-use it's targets with new limiter rules. Two instance methods are provided:
### `FetchManager.kill`
This will immediately stop processing the queue and all awaiting requests will be rejected with the message "Target group was killed".
```ts
const fm = new FetchManager(..., hosts: [...]);
/* Application does stuff with fm */
await fm.kill();
/* Targets can now be re-used in new instances */
```

### `FetchManager.stop`
This will wait for the queue to drain before killing it. It is up to the user to stop feeding the queue, else it will never drain.
```ts
const fm = new FetchManager(..., hosts: [...]);
/* Application does stuff with fm */
await fm.stop();
/* Targets can now be re-used in new instances */
```

## Installation
[top](#fetchmanager)
```bash
bun install fetch-man # NPM
bun install https://github.com/citkane/fetchmanager
```

```bash
npm i fetch-man # NPM
npm i https://github.com/citkane/fetchmanager
```

## More resources
[top](#fetchmanager)
### Types
Fetch Manager types are under the `fm` namespace. They are annotated with examples, so your IDE should give you helpful documentation.
### LibFetch
A library of off the shelf re-usable callbacks:
```ts
import LibFetch from "fetch-man/lib";
const lib_fetch = new LibFetch();
const wait_cb = lib_fetch.wait.backoff_factory()
const retry_cb = lib_fetch.retry...
...etc
```

### Tests
Tests are made for the Bun framework. You can examine these to better understand the expectations for various aspects of the library.
```bash
bun run_tests
```

## Demo
[top](#fetchmanager)

Try a rather nifty WikiData explorer!
```bash
node --run=wikidata
```

```bash
bun ./demo/wikidata/

```

## What about Deno?
I don't use Deno, so I haven't tried it with this library. It will probably work.

## What about the browser?
I haven't needed that yet. If you build the TS with a browser target, it will probably work.

## Why another `fetch` library?
Because my attention span is rather limited... While working on an application that aggragates data from a number of API's with different rate rules and paging logic,
I wanted something specific with zero dependencies. I wanted it to be as close to the native `fetch` syntax as possible. The result is this library.
It has dramatically reduced my app's boilerplating.

## Similar libraries:
- [axios-rate-limit](https://www.npmjs.com/package/axios-rate-limit)
- [node-rate-limiter-flexible](https://github.com/animir/node-rate-limiter-flexible/wiki/Overall-example#third-party-api-crawler-bot-rate-limiting)
- [limiter](https://www.npmjs.com/package/limiter)
- [bottleneck](https://www.npmjs.com/package/bottleneck)
