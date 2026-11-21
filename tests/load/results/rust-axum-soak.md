# Load result: rust-axum (soak)

Machine: Apple M4 Max, 16 cores, 48 GiB, Darwin 25.5.0 arm64, Node v24.5.0. Started 2026-11-21T13:57:08.523Z.

Fixture start command: `adapters/rust/target/release/rust-conformance`.

## Idle overhead (bench disabled vs enabled; median of 8 alternating 1500 ms bursts)

| Route | Disabled rps | Enabled rps | Ratio | Disabled p50/p99 ms | Enabled p50/p99 ms | Errors |
| --- | --- | --- | --- | --- | --- | --- |
| ready@1 | 31153.2 | 31155 | 1 | 0.03 / 0.08 | 0.03 / 0.08 | 0 |
| ready@16 | 60210.3 | 58021.8 | 0.964 | 0.24 / 0.55 | 0.25 / 0.64 | 0 |
| read@1 | 16055 | 14911.9 | 0.929 | 0.05 / 0.16 | 0.06 / 0.17 | 0 |
| read@16 | 53953.4 | 51682.3 | 0.958 | 0.25 / 0.62 | 0.27 / 0.9 | 0 |
| write@1 | 8551.8 | 9078.8 | 1.062 | 0.09 / 0.22 | 0.1 / 0.22 | 0 |
| write@16 | 10589.3 | 12117.2 | 1.144 | 0.68 / 7.9 | 0.64 / 12.27 | 0 |
| send@1 | - | 4260.5 | - | - | 0.18 / 7.03 | 0 |
| send@16 | - | 8986.3 | - | - | 0.92 / 14.52 | 0 |
| observedSend@1 | - | 4535.7 | - | - | 0.17 / 0.5 | 0 |
| observedSend@16 | - | 8686.7 | - | - | 1.29 / 48.71 | 0 |
| preview@1 | - | 5115 | - | - | 0.18 / 0.38 | 0 |
| preview@16 | - | 4985.1 | - | - | 1.65 / 2.62 | 0 |

## Preview and observed Send at concurrency 32: PASS

| Check | Requests | rps | p50 / p95 / p99 ms | Failed | Left behind / missing |
| --- | --- | --- | --- | --- | --- |
| previewDistinctIds | 1000 | 4440.7 | 4.48 / 5.23 / 26.79 | 0 | 0 |
| previewSameId | 1000 | 3666.6 | 4.45 / 5 / 15.28 | 0 | 0 |
| previewSameRow | 1000 | 4685.3 | 3.98 / 4.6 / 12.2 | 0 | 0 |
| observedSend | 500 | 3728.7 | 4.09 / 6.37 / 44.06 | 0 | 0 |

Traces issued 500, still readable 8, misattributed 0.

## Memory soak, 300s at concurrency 24: BOUNDED

| Start MiB | Mid-run median | Final median | Growth MiB | Slope MiB/min | Peak MiB | Idle after settle MiB |
| --- | --- | --- | --- | --- | --- | --- |
| 31.2 | 32.3 | 30.6 | -1.7 | -1.72 | 35.1 | 31.2 |

Load: 647560 requests, 2157.4 rps, p50/p95/p99 6.08 / 24.26 / 97.92 ms, 0 failed (0%). Statuses: {"200":453301,"201":161874,"413":32385}.
Throughput per 25s window (rps): 2423, 2501, 1624, 2645, 2374, 2285, 2413, 2409, 2024, 830, 2087, 2282.
Host load average (1 min) at each window end: 7.1, 9.7, 9.9, 9.3, 9.8, 9.9, 9, 8.4, 7.9, 18.3, 17.4, 15.1 (16 cores). Dips in throughput that line up with a high load are the host, not the app.

Mean latency (ms) per window by request type:

| Type | w1 | w2 | w3 | w4 | w5 | w6 | w7 | w8 | w9 | w10 | w11 | w12 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| read | 6.78 | 6.41 | 10.2 | 6.19 | 6.84 | 7.04 | 6.74 | 6.71 | 7.89 | 19.6 | 7.64 | 7.08 |
| preview | 9.95 | 9.3 | 14.53 | 8.91 | 10.11 | 10.67 | 9.92 | 10 | 12.15 | 29.01 | 11.53 | 11.11 |
| sendBody | 12.88 | 12.88 | 17.75 | 10.95 | 12.79 | 13.67 | 13.14 | 12.8 | 15 | 37.04 | 14.37 | 13.16 |
| large | 9.81 | 10.22 | 16.16 | 10.59 | 10.98 | 10.17 | 10.31 | 10.25 | 11.65 | 31.04 | 11.18 | 10.8 |
| previewBody | 8.78 | 9.91 | 16.04 | 9.25 | 10.37 | 10.44 | 9.18 | 10.65 | 11.47 | 28.74 | 13.04 | 11.59 |
| send | 11.41 | 11.55 | 18.1 | 10.97 | 11.99 | 12.26 | 11.94 | 11.97 | 13.71 | 36.91 | 13.73 | 11.58 |
| capture | 14.65 | 13.94 | 21.17 | 12.83 | 14.11 | 15.1 | 13.83 | 13.36 | 16.92 | 33.84 | 15.44 | 13.92 |

Overall: PASS
