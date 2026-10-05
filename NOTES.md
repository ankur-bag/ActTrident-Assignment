# Implementation Notes

## What I changed

Added true HTTP response streaming for requests with `"stream": true`.

Previously, the gateway called `await upstream.text()`, which buffered the complete upstream response before sending anything to the client. Streaming requests now forward `upstream.body` through Node's built-in stream pipeline so SSE chunks reach the client as they arrive, with standard backpressure handling.

The request flow remains:

`request → parse → screen → forward → response`

Screening therefore completes before any request is forwarded upstream. Non-streaming requests retain the existing buffered-response behavior.

I also restored the declared configuration defaults. Previously, `GATE_SCREENING` being unset caused screening to be disabled even though the configured default was `"1"`.

Response forwarding was adjusted to preserve useful upstream status/headers while excluding stale body-length/encoding and hop-by-hop headers. Client disconnects abort upstream work; failures before headers are sent return `502`, while failures after streaming begins terminate the connection.

## Verification

Tested locally with Node.js v24.14.1.

Verified behavior:

- `/healthz` returns `200` with `screening: true` and `mode: "block"`.
- Safe non-streaming requests return `200`.
- Dangerous requests are blocked with `403`.
- Streaming requests deliver SSE data progressively rather than buffering the complete response.
- Gzip responses decode correctly after removing stale upstream encoding metadata.
- `src/upstream.js` remains unchanged.

Automated test:

```text
SSE first=137 ms, finished=632 ms
tests 1
pass 1
fail 0
```

Receiving the first SSE data at `137 ms`, while the complete stream finished at `632 ms`, confirms that the response is being forwarded incrementally.

## Benchmark

Command:

```bash
node src/bench.js --requests 60 --concurrency 8
```

### Before

```text
requests     60  (60 ok)
concurrency  8
wall clock   444 ms
avg latency  7.4 ms
throughput   135.1 req/s

requests     60  (60 ok)
concurrency  8
wall clock   434 ms
avg latency  7.2 ms
throughput   138.2 req/s

requests     60  (60 ok)
concurrency  8
wall clock   431 ms
avg latency  7.2 ms
throughput   139.2 req/s
```

Median throughput: **138.2 req/s**

### After

```text
requests     60  (60 ok)
concurrency  8
wall clock   454 ms
avg latency  7.6 ms
throughput   132.2 req/s

requests     60  (60 ok)
concurrency  8
wall clock   430 ms
avg latency  7.2 ms
throughput   139.5 req/s

requests     60  (60 ok)
concurrency  8
wall clock   420 ms
avg latency  7.0 ms
throughput   142.9 req/s
```

Median throughput: **139.5 req/s**

The before/after ranges overlap, and the median throughput is effectively unchanged. Based on these small local runs, I do not see evidence of a meaningful performance regression.

The supplied benchmark exercises the non-streaming path, so it should not be interpreted as a streaming-throughput benchmark.

## Additional observations

The original configuration helper declared default values but did not apply them, causing screening to be disabled when `GATE_SCREENING` was unset.

The original response forwarding could also preserve `content-encoding: gzip` after Node's `fetch()` had already decompressed the response body, which caused clients to attempt decompression again.

The benchmark's displayed `avg latency` is calculated from total wall-clock time divided by request count. With concurrent requests, this is not the true arithmetic mean of individual request latency, so I treated wall-clock duration and throughput as the more useful comparison metrics.

## Deliberately not changed

I kept the scope focused and did not:

- modify `src/upstream.js`
- modify the benchmark implementation
- add frameworks or dependencies
- build frontend/UI functionality
- redesign the screening rules
- make unrelated architectural changes

The gateway still buffers the complete incoming request before screening and currently has no explicit body-size limit or request-read timeout. Those would be reasonable production hardening improvements but were left outside the scope of this task.

## AI Assistance

AI assistance was used during repository inspection and development. All submitted code changes, test results, and benchmark measurements were reviewed and verified locally before submission.