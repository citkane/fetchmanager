# fetch-man (Fetch Manager)
A zero dependency wrapper around native Javascript `fetch` providing management of:
- rate limitting
- concurrency
- paging
- response data

For Node, Bun and the broowser (and probably Deno too).
### toc
- [Basic Usage](#basic-usage)
- [Core concepts](#core-concepts)
- [Paging](#paging)
- [Trace](#trace)
- [Aborting](#aborting)
- [Options and overloads](#options-and-overloads)
- [Advanced Usage](#advanced-usage)
- [Distributed architectures](#distributed-architectures)
- [Instance destruction](#instance-destruction)
- [Installation](#installation)
- [More Resources](#more-resources)
- [Demo](#demo)
- [What about Deno?](#what-about-deno)
- [Why another fetch library?](#why-another-fetch-library)
- [Similar libraries](#similar-libraries)

## Basic usage
[top](#toc)
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
    /* If the global `RequestInit` type definition is not compliant, then force TS typing
     * Ensure that your global `fetch` is capable of accepting the non-standard shape */
    { tls: { rejectUnauthorized: false } } as RequestInit, 
    handlers,
);
```

## Core concepts
[top](#toc)

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

Caching and orchestration frameworks are outside the scope of this library, and left to the user to implement their own.

If and when rate / concurrency limits are reached for an instance, it's queue is paused until the limits are once again within allowances.
Logic such as paging and adaptive retry strategies are managed by user provided callback handlers:
- `retry_cb`: answers "*should I retry this failed request?*" with a boolean response,
- `wait_cb`: answers "*for how long to pause the queue?*" with a number in ms,
- `pager_cb`: answers "*is there more data?*" with nullish for false or a new request for true,
- `response_cb`: manipulates the response payload into a desired data shape before resolving it.
- `trace_cb`: provides diagnostic data about the state of the queue.

Handlers (excepting trace) are injected with the `Response | Error` as well as the request in it's given shape: (see the `fm.req` type).
The pager_cb is injected also with an (optional) `collect` function to facilitate flattening the final data return. 

Handlers can be set at 3 cascading levels of priority (excepting pager):
1) per individual request
2) at class instantiation per individual target
3) at class instantiation for the whole target group.

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
[top](#toc)

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
const all_data = await fm.fetch<bar_type["data"][]>(req, pager_cb);
```

`pager_cb` will cause `fm.fetch` to always return an `Array`.

In the above example, we used the `collect` utility function. It is slightly opinionated. If `data` is `any[]`,
then it will flatten the paged results so that `all_data` is also `any[]`.
This behaviour can be overidden with `collect(data, false)` in which case `all_data` will be `any[][]`

Usage of `collect` is optional. If not used, `all_data` will be one of:
- If `response_cb` is defined: `Awaited<ReturnType<response_cb>>[]` else
- `Response[]` 


## Trace
[top](#toc)

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

## Aborting
Native Javascript `fetch` uses [signals](https://developer.mozilla.org/en-US/docs/Web/API/Request/signal) to manage user controlled aborts.
This is compatible with Fetch Manager, eg.
```ts
let count = 0;
const controller = new AbortController();
const { signal } = controller;
signal.addEventListener("abort", () => console.log("abort", count));
const response_cb: fm.cb.resp = (resp, _req) => {
    count ++;
    if(count > 1) controller.abort()
    return resp.ok;
}

const promises = [...Array(4)].map(
    () => fm.fetch("https://foo.com", { signal }, { response_cb })
        .catch(() => false);
);
const two_of_four = await Promise.all(promises) // returns [true, true, false, false] and logs "abort 2"
```

However, because Fetch Manager is queing requests for unknown lengths of time,
using the native [AbortSignal.timeout](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/timeout_static) method at the user call will lead to unexpected timing results.
For this purpose, you can set the `abort_timeout` option (in ms) at three levels of priority:
- Per request, in the `fm.fetch` properties object (priority 1)
- Default for a target in it's class initialiser options (priority 2)
- Default for all targets in the class initialiser options (priority 3)

For example, to set it for a request:
```ts

const controller = new AbortController();
const { signal } = controller;
const req = new Request("https://foo.com", { signal });
const resp = await fm.fetch(req, { abort_timeout: 1000 }) // Will abort if the request takes longer than 1000ms
    .catch((err) => console.error(err.name))              // "TimeoutError" or "AbortError" 

// ...Do stuff that consumes time...

controller.abort();
```

Fetch Manager will add the timeout signal just in time before the request is sent.
The user signal will also be available.


## Options and overloads
[top](#toc)

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
    /* Options defined hereunder are 
     * fallen back on as priority (3) */
        abort_timeout?: number,             // Number of ms after request is sent until abort
        retry_cb?: fm.cb.retry,             
        wait_cb?: fm.cb.wait,
        trace_cb?: fm.cb.trace,
    },
})

```
If a bucket for the instance is available, that can be used to initialise an instance, thus preserving or migrating the state of limits:
```ts
const bucket = FetchManager.bucket.get(fm.uid);
save_to_file(bucket)

// Server restarts

const bucket: fm.bucket = get_from_file(bucket)
const fm = new FetchManager({
    bucket,
    targets: [...],
    options?: {...}
})

```
The bucket must match the targets, ie. the uid hash of the bucket must align with the targets definition else an error will be thrown.

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

In the shape below, fallback options are specified for "bar.domain.com"
```ts
[
    "foo.domain.com",
    {
        target_key: "bar.domain.com",
        /* Options defined hereunder are
        fallen back on as priority (2) */
        abort_timeout?: number,              // Number of ms after request is sent until abort
        response_cb?: fm.cb.resp,       
        retry_cb?: fm.cb.retry,
        wait_cb?: fm.cb.wait,
        trace_cb?: fm.cb.trace,
    }
]
```

It is important that a target is only defined once across all instances. Fetch Manager in a single thread environment 
will throw errors on conflicts - but orchestrators of distributed systems should be mindful of this,
and more complex scenarios such as the following:

instance_1 target defined as:
```ts
["foo.com"]
```
This will catch all API endpoints for foo.com, but foo.com may have endpoints with different rate limits, so we can do:

instance_2 target defined as:
```ts
["foo.com/api/special"]    
```
Now calling `instance_1.fetch("https://foo.com/api/special")` is an error, because even though `instance_1` *can* catch it, it's limit rules are implemented on `instance_2`.
In a single threaded environment, Fetch Manager will throw an error - but in a distributed sytem the conflict will need to be flagged externally.

### Fetch
In order to cater for non-standard `RequestInit` forms, a request can be defined as one of two shapes:
- <`Request`> or
- <`string`, `{...}` as RequestInit>

`fm.fetch(Request)` is effectively the same as `fm.fetch("url", {...} as RequestInit)`, except you have the ability to pass non-standard options
which native `new Request` would otherwise reject. For convenience this overload will be notated below as `<fm.req>`

The anatomy of a fetch is thus ordered as follows:
```ts
fm.fetch(<fm.req>, options?, pager_cb?)
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
Options passed directly to fm.fetch are priority (1). They will override any options set at individual target level (2) or target group level (3).
```ts
{
    skip_queue?: boolean,           // Send this request to the front of the queue
    force_retry?: number,           // Retry this request x amount of times. -x to retry from the queue front 
    /* Options defined hereunder 
     * are first priority (1) */
    abort_timeout?: number,         // Number of ms after request is sent until abort
    response_cb?: fm.cb.resp,              
    retry_cb?: fm.cb.retry,         // retry_cb always retries from the front of the queue
    wait_cb?: fm.cb.wait,
    trace_cb?: fm.cb.trace,
}

```

## Advanced usage
[top](#toc)

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
This option is by nature quirky and opinionated. The examples below will illustrate.
```ts
const buggy_endpoint = fm.fetch("http://foo.com/api/buggy", {force_retry: 5})
const important_stuff = Promise.all([...Array(10)].map(() => fm.fetch("https://foo.com/api/stuff")))
```

If `buggy_endpoint` fails for any reason, it will be re-tried for up to 5 times from the back of the queue.
All of `important_stuff` will thus be requested before `buggy_endpoint` retries.
There are some quirks to this behaviour:
- If the default retry wait is set to 500ms, `important_stuff` will proceed immediately and not wait on the buggy failure.
- If `important_stuff` consumes 300ms to complete it's requests, then `buggy_endpoint` will wait the remaining 200ms before retrying.
- if the user has provided `wait_cb`, and it returns eg. 1000ms (maybe a rate limit is being imposed) - then the whole queue, including `important_stuff`, will wait for 1000ms

We can also do the inverse, and prioritise request retries to the front of the queue.
```ts
const buggy_important = fm.fetch("http://foo.com/api/buggy", {force_retry: -5})
const normal_stuff = Promise.all([...Array(10)].map(() => fm.fetch("https://foo.com/api/stuff")))
```

Note the negative (-5). `buggy_important` will now retry up to five times from the front of the queue before `normal_stuff` is requested.
If the buggy endpoint takes longer to respond (or error) than the retry wait time, then `normal_stuff` will fill in the gaps with requests.

Consider `force_retry` as an override to prioritise / de-prioritise a single request. A user provided `retry_cb` will be by-passed until all the `force_retry` counts have been depleted.

## Distributed architectures
[top](#toc)

In a single thread, Fetch Manager will error and warn on conflicts between instances.
In a distributed system, the tracking of rates and limits state will have to be orchestrated at a higher level.

Fetch Manager does not in and of itself provide orchestration tooling, but it does expose helpers to access and set the needed data.
A bucket contains the limits and current rates for a target group. It is linked to a class instance (a group of targets) by it's hash uid.
- `fm.uid`                                          - Instance uid (it's a hash of target keys sorted longest to shortest) 
- `FetchManager.buckets`                            - Static map of uid keyed buckets
- `FetchManager.bucket.get(uid_or_target)`          - Get a bucket
- `FetchManager.bucket.set(uid_or_target, bucket)`  - Set a bucket
- `FetchManager.targets`                            - Static map of uid keyed target key groups
- `FetchManager.hash(targets: fm.target[])`         - Create a uid and sorted array of target keys from a target group.

A naive, illustrative pseudo-example for orchestration could look like this:
```ts
// source thread
const all_targets = FetchManager.targets
const buckets = FetchManager.buckets
your_orchestration.publish("update", all_targets, buckets)

```
```ts
// destination thread

const fm: { [uid: string]: InstanceType<FetchManager> } = {...}
const fm_targets: { [uid: string]: fm.target[] } = {...}
const fm_options: { [uid:string]: fm.opts.global<fm.kind>} ] = {...}

your_orchestration.on("update", (all_targets, buckets) => {
    Object.entries(buckets).forEach(([uid, bucket]) => {
        const targets = fm_targets[uid] || all_targets[uid]!;
        const options = fm_options[uid] || {};
        if(!fm[uid]) return (fm[uid] = new FetchManager(bucket, targets, options));
    
        const ex_bucket = FetchManager.bucket.get(uid)!;
        bucket.tokens = Math.min(bucket.tokens, ex_bucket.tokens);
        bucket.concurrency = Math.max(bucket.concurrency, ex_bucket.concurrency);
        FetchManager.bucket.set(uid, bucket);
    )}
)}
```

<details>
<summary>bucket details</summary>

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

Once a bucket is set, only `tokens` and `concurrency` can be updated. `time` will be `0` until the first request is made on a new bucket.

When orchestrating, it is up to the user to validate:
- That new values are less favourable than the existing values (the local limiter will be adjusting them favourably)
- That timestamps are within tolerance
- That new buckets are created with the same limits across the entire system.

</details>

If limit settings across a distributed system differ, then global rate calculations will be corrupted.

## Instance destruction
[top](#toc)

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

To cancel in-flight requests, the user should set up an `AbortSignal` and call it from their application code.

## Installation
[top](#toc)
```bash
bun i fetch-man # NPM
bun i citkane/fetchmanager#v0.1.0 #Github

npm i fetch-man # NPM
npm i citkane/fetchmanager#v0.1.0 #Github

```

## More resources
[top](#toc)
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
[top](#toc)

Try a rather nifty WikiData explorer!
```bash
node --run=wikidata
```

```bash
bun ./demo/wikidata/
```

## What about Deno?
I don't use Deno, so I am not familiar with it's ecosystem and haven't tried Fetch Manager on it. It will probably work.

## Why another `fetch` library?
Because my attention span is rather limited... While working on an application that aggregates data from a number of API's with different rate rules and paging logic,
I wanted something with zero dependencies that is as close to the native `fetch` syntax as possible. The result is this library.
It has dramatically reduced my app's boilerplating.

## Similar libraries:
- [axios-rate-limit](https://www.npmjs.com/package/axios-rate-limit)
- [node-rate-limiter-flexible](https://github.com/animir/node-rate-limiter-flexible/wiki/Overall-example#third-party-api-crawler-bot-rate-limiting)
- [limiter](https://www.npmjs.com/package/limiter)
- [bottleneck](https://www.npmjs.com/package/bottleneck)
