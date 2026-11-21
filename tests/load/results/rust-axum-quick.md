# Load result: rust-axum (quick)

Machine: Apple M4 Max, 16 cores, 48 GiB, Darwin 25.5.0 arm64, Node v24.5.0. Started 2026-11-21T13:28:37.856Z.

Fixture start command: `adapters/rust/target/release/rust-conformance`.

## Memory soak, 40s at concurrency 24: BOUNDED

| Start MiB | Mid-run median | Final median | Growth MiB | Slope MiB/min | Peak MiB | Idle after settle MiB |
| --- | --- | --- | --- | --- | --- | --- |
| 28 | 30.2 | 30.5 | 0.3 | 4.66 | 30.5 | 30.5 |

Load: 94868 requests, 2368.9 rps, p50/p95/p99 6.12 / 15.94 / 71.41 ms, 0 failed (0%). Statuses: {"200":66335,"201":23819,"413":4714}.
Throughput per 5s window (rps): 2382, 2416, 1220, 2681, 2128, 2617, 2591, 2934.

Mean latency (ms) per window by request type:

| Type | w1 | w2 | w3 | w4 | w5 | w6 | w7 | w8 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| large | 13.17 | 8.15 | 22.81 | 7.34 | 13.37 | 12.47 | 9.72 | 6.49 |
| preview | 9.31 | 9.62 | 20.75 | 9.63 | 10.8 | 8.96 | 9.55 | 8.82 |
| capture | 12.21 | 16.22 | 16.61 | 11.69 | 17.61 | 13.45 | 14.08 | 11.2 |
| send | 11.63 | 13.05 | 20.74 | 12.09 | 13.14 | 11.54 | 11.41 | 9.89 |
| read | 6.86 | 6.71 | 10.48 | 5.95 | 7.7 | 6.22 | 6.34 | 5.48 |
| sendBody | 12.83 | 13.2 | 39.64 | 10.92 | 13 | 11.47 | 10.98 | 9.55 |
| previewBody | 11.48 | 7.56 | 10.14 | 8.24 | 9.13 | 7.92 | 7.25 | 8.88 |

Overall: PASS
