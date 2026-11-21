# Load result: dotnet-aspnetcore (soak)

Machine: Apple M4 Max, 16 cores, 48 GiB, Darwin 25.5.0 arm64, Node v24.5.0. Started 2026-11-21T16:34:22.841Z.

Fixture start command: `dotnet examples/DotnetConformance/bin/Release/net10.0/DotnetConformance.dll`.

## Idle overhead (bench disabled vs enabled; median of 8 alternating 1500 ms bursts)

| Route | Disabled rps | Enabled rps | Ratio | Disabled p50/p99 ms | Enabled p50/p99 ms | Errors |
| --- | --- | --- | --- | --- | --- | --- |
| ready@1 | 17808.9 | 17923.4 | 1.006 | 0.05 / 0.19 | 0.05 / 0.18 | 0 |
| ready@16 | 56682.4 | 57135.3 | 1.008 | 0.24 / 0.57 | 0.24 / 0.55 | 0 |
| read@1 | 2329.3 | 2338.1 | 1.004 | 0.4 / 0.86 | 0.4 / 0.86 | 0 |
| read@16 | 9505.5 | 9489.5 | 0.998 | 1.17 / 3.07 | 1.15 / 3.13 | 0 |
| write@1 | 1039.6 | 1062.9 | 1.022 | 0.9 / 1.6 | 0.89 / 1.46 | 0 |
| write@16 | 3573.9 | 3713.4 | 1.039 | 0.32 / 151.81 | 0.32 / 151.29 | 0 |
| send@1 | - | 672.6 | - | - | 1.23 / 6.9 | 0 |
| send@16 | - | 3048.4 | - | - | 0.46 / 303.52 | 0 |
| observedSend@1 | - | 687.3 | - | - | 1.29 / 7.88 | 0 |
| observedSend@16 | - | 2795.7 | - | - | 0.49 / 154.83 | 0 |
| preview@1 | - | 1814.3 | - | - | 0.51 / 1.09 | 0 |
| preview@16 | - | 2645.9 | - | - | 0.29 / 151.93 | 0 |

## Preview and observed Send at concurrency 32: PASS

| Check | Requests | rps | p50 / p95 / p99 ms | Failed | Left behind / missing |
| --- | --- | --- | --- | --- | --- |
| previewDistinctIds | 1000 | 467.3 | 10.62 / 79.67 / 624.1 | 0 | 0 |
| previewSameId | 1000 | 507.8 | 7.93 / 14.75 / 1064.5 | 0 | 0 |
| previewSameRow | 1000 | 599.4 | 5.34 / 10.01 / 606.93 | 0 | 0 |
| observedSend | 500 | 463.3 | 0.53 / 161.59 / 462.66 | 0 | 0 |

Traces issued 500, still readable 8, misattributed 0.

## Memory soak, 300s at concurrency 24: BOUNDED

| Start MiB | Mid-run median | Final median | Growth MiB | Slope MiB/min | Peak MiB | Idle after settle MiB |
| --- | --- | --- | --- | --- | --- | --- |
| 386.3 | 417.2 | 437.1 | 19.9 | 4.16 | 473.6 | 422.6 |

Load: 586758 requests, 1953.7 rps, p50/p95/p99 0.5 / 5.95 / 304.33 ms, 0 failed (0%). Statuses: {"200":410556,"201":146952,"413":29250}.
Throughput per 25s window (rps): 2013, 2012, 2015, 1924, 1961, 1968, 2015, 1921, 1773, 1953, 1954, 1962.
Host load average (1 min) at each window end: 15.8, 18.4, 17.7, 17.5, 16.8, 17.4, 18.1, 15.2, 14.9, 20.7, 20.6, 19.7 (16 cores). Dips in throughput that line up with a high load are the host, not the app.

Mean latency (ms) per window by request type:

| Type | w1 | w2 | w3 | w4 | w5 | w6 | w7 | w8 | w9 | w10 | w11 | w12 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| read | 0.67 | 0.68 | 0.55 | 0.26 | 0.44 | 0.52 | 0.68 | 0.45 | 0.41 | 0.65 | 0.56 | 0.6 |
| preview | 14.99 | 15.53 | 14.78 | 16.98 | 15.63 | 15.89 | 14.6 | 16.1 | 17.73 | 15.35 | 16.32 | 15.94 |
| send | 14.58 | 14.67 | 16.21 | 14.88 | 15.82 | 16.65 | 16.36 | 15.76 | 17.63 | 16.89 | 15.63 | 14.47 |
| capture | 18.09 | 19.76 | 18.48 | 19.85 | 18.19 | 18.64 | 18.57 | 20.72 | 18.5 | 17.35 | 21.09 | 18.02 |
| previewBody | 11.74 | 12.82 | 10.35 | 11.87 | 13.1 | 11.11 | 11.35 | 12.44 | 16.87 | 12.5 | 9.18 | 11.67 |
| sendBody | 19.6 | 17.35 | 20.18 | 19.45 | 19.07 | 18.13 | 17.94 | 19.63 | 20.28 | 19.6 | 20.05 | 20.69 |
| large | 16.34 | 15.1 | 13.79 | 14.31 | 15.41 | 15.01 | 17.05 | 15.87 | 16.05 | 14.38 | 13.27 | 13.72 |

Host load average (1 min) before / after each phase on 16 cores: idle 17 / 16.6, concurrency 16.6 / 18.9, soak 18.9 / 23. A load above the core count means other work competed with the run.

Overall: PASS
