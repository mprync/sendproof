# Load result: go-net-http (soak)

Machine: Apple M4 Max, 16 cores, 48 GiB, Darwin 25.5.0 arm64, Node v24.5.0. Started 2026-11-21T16:17:18.311Z.

Fixture start command: `artifacts/go/fixture nethttp sql`.

## Idle overhead (bench disabled vs enabled; median of 8 alternating 1500 ms bursts)

| Route | Disabled rps | Enabled rps | Ratio | Disabled p50/p99 ms | Enabled p50/p99 ms | Errors |
| --- | --- | --- | --- | --- | --- | --- |
| ready@1 | 24354.9 | 23997.5 | 0.985 | 0.04 / 0.11 | 0.04 / 0.11 | 0 |
| ready@16 | 62066.4 | 62227.8 | 1.003 | 0.23 / 0.51 | 0.23 / 0.52 | 0 |
| read@1 | 18059.8 | 17905.8 | 0.991 | 0.05 / 0.15 | 0.05 / 0.14 | 0 |
| read@16 | 38387.9 | 39276.4 | 1.023 | 0.25 / 1.66 | 0.25 / 1.63 | 0 |
| write@1 | 11287.7 | 10488.8 | 0.929 | 0.07 / 0.22 | 0.09 / 0.29 | 0 |
| write@16 | 12363.2 | 12390.2 | 1.002 | 0.07 / 33.17 | 0.07 / 33.16 | 0 |
| send@1 | - | 9064.6 | - | - | 0.1 / 0.27 | 0 |
| send@16 | - | 8185.3 | - | - | 0.1 / 33.32 | 0 |
| observedSend@1 | - | 5732.4 | - | - | 0.15 / 1.28 | 0 |
| observedSend@16 | - | 7592.9 | - | - | 0.13 / 53.3 | 0 |
| preview@1 | - | 8693.6 | - | - | 0.1 / 0.33 | 0 |
| preview@16 | - | 12422 | - | - | 0.1 / 33.19 | 0 |

## Preview and observed Send at concurrency 32: PASS

| Check | Requests | rps | p50 / p95 / p99 ms | Failed | Left behind / missing |
| --- | --- | --- | --- | --- | --- |
| previewDistinctIds | 1000 | 2237.7 | 0.16 / 18.17 / 78.94 | 0 | 0 |
| previewSameId | 1000 | 7876.6 | 0.12 / 8.5 / 55.29 | 0 | 0 |
| previewSameRow | 1000 | 9160.2 | 0.1 / 8.26 / 53.42 | 0 | 0 |
| observedSend | 500 | 914 | 0.17 / 33.36 / 135.93 | 0 | 0 |

Traces issued 500, still readable 8, misattributed 0.

## Memory soak, 300s at concurrency 24: BOUNDED

| Start MiB | Mid-run median | Final median | Growth MiB | Slope MiB/min | Peak MiB | Idle after settle MiB |
| --- | --- | --- | --- | --- | --- | --- |
| 52.5 | 55.9 | 56.9 | 1 | -0.92 | 57 | 53.3 |

Load: 1024945 requests, 3415.5 rps, p50/p95/p99 0.28 / 21.06 / 113.83 ms, 0 failed (0%). Statuses: {"200":717475,"201":256393,"413":51077}.
Throughput per 25s window (rps): 3966, 3727, 3861, 3817, 3728, 3060, 3301, 3053, 3840, 2848, 2865, 2929.
Host load average (1 min) at each window end: 25, 28.2, 26.4, 26.3, 23.2, 23.8, 19.6, 17.5, 19.5, 22.5, 18.1, 20.3 (16 cores). Dips in throughput that line up with a high load are the host, not the app.

Mean latency (ms) per window by request type:

| Type | w1 | w2 | w3 | w4 | w5 | w6 | w7 | w8 | w9 | w10 | w11 | w12 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| read | 0.14 | 0.15 | 0.15 | 0.14 | 0.14 | 0.14 | 0.14 | 0.14 | 0.14 | 0.15 | 0.17 | 0.16 |
| preview | 6.89 | 7.78 | 7.38 | 7.22 | 7.94 | 8.71 | 9.17 | 9.31 | 7.29 | 10.69 | 10.08 | 9.36 |
| send | 7.19 | 7.62 | 7.37 | 7.47 | 7.47 | 9.98 | 8.25 | 8.36 | 7.49 | 9.83 | 10.55 | 9.71 |
| previewBody | 10.81 | 10.74 | 10.86 | 12.07 | 11.9 | 14.81 | 13.13 | 13.08 | 11.72 | 12.08 | 13.25 | 13.58 |
| sendBody | 10.03 | 10.98 | 10.12 | 10.42 | 10.74 | 13.87 | 12.39 | 14.11 | 10.3 | 14.81 | 14.11 | 15.88 |
| large | 8.31 | 8.1 | 8.6 | 7.17 | 7.39 | 10.73 | 7.91 | 10.18 | 7.51 | 8.35 | 9.24 | 9.7 |
| capture | 10.48 | 9.69 | 9.73 | 10.25 | 10.63 | 12.04 | 9.65 | 14.03 | 11.08 | 12.56 | 13.73 | 12.79 |

Host load average (1 min) before / after each phase on 16 cores: idle 25.1 / 20.6, concurrency 20.6 / 20.6, soak 20.6 / 17.4. A load above the core count means other work competed with the run.

Overall: PASS
