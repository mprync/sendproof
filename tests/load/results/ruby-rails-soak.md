# Load result: ruby-rails (soak)

Machine: Apple M4 Max, 16 cores, 48 GiB, Darwin 25.5.0 arm64, Node v24.5.0. Started 2026-11-21T14:28:24.578Z.

Fixture start command: `bash adapters/ruby/bin/fixture`.

## Idle overhead (bench disabled vs enabled; median of 8 alternating 1500 ms bursts)

| Route | Disabled rps | Enabled rps | Ratio | Disabled p50/p99 ms | Enabled p50/p99 ms | Errors |
| --- | --- | --- | --- | --- | --- | --- |
| ready@1 | 2768.2 | 2630.8 | 0.95 | 0.34 / 0.85 | 0.34 / 1.6 | 0 |
| ready@16 | 2269.3 | 2084.2 | 0.918 | 6.46 / 22.64 | 6.43 / 26.45 | 0 |
| read@1 | 1481.1 | 1576.7 | 1.065 | 0.59 / 2.17 | 0.59 / 1.54 | 0 |
| read@16 | 1343.8 | 1252.4 | 0.932 | 10.7 / 40.1 | 10.54 / 54.11 | 0 |
| write@1 | 1227.2 | 1064.2 | 0.867 | 0.71 / 1.69 | 0.76 / 3.34 | 0 |
| write@16 | 982.8 | 971.7 | 0.989 | 15.78 / 55.75 | 15.86 / 89.51 | 0 |
| send@1 | - | 966 | - | - | 0.92 / 2.85 | 0 |
| send@16 | - | 979.3 | - | - | 14.62 / 46.71 | 0 |
| observedSend@1 | - | 814.2 | - | - | 1.09 / 2.83 | 0 |
| observedSend@16 | - | 661.2 | - | - | 20.1 / 240.06 | 0 |
| preview@1 | - | 743.6 | - | - | 1.3 / 4.26 | 0 |
| preview@16 | - | 772.1 | - | - | 19.88 / 46.62 | 0 |

## Preview and observed Send at concurrency 32: PASS

| Check | Requests | rps | p50 / p95 / p99 ms | Failed | Left behind / missing |
| --- | --- | --- | --- | --- | --- |
| previewDistinctIds | 1000 | 679.3 | 45.92 / 60.65 / 68.35 | 0 | 0 |
| previewSameId | 1000 | 869.5 | 35.92 / 49.01 / 52.35 | 0 | 0 |
| previewSameRow | 1000 | 859.4 | 36.71 / 42.18 / 42.97 | 0 | 0 |
| observedSend | 500 | 509.1 | 49.45 / 129.92 / 161.82 | 0 | 0 |

Traces issued 500, still readable 8, misattributed 0.

## Memory soak, 300s at concurrency 24: BOUNDED

| Start MiB | Mid-run median | Final median | Growth MiB | Slope MiB/min | Peak MiB | Idle after settle MiB |
| --- | --- | --- | --- | --- | --- | --- |
| 143.5 | 127.1 | 126.2 | -0.9 | -5.74 | 158.8 | 142.2 |

Load: 69959 requests, 233.1 rps, p50/p95/p99 79.48 / 234.11 / 394.53 ms, 0 failed (0%). Statuses: {"200":49015,"201":17381,"413":3563}.
Throughput per 25s window (rps): 249, 218, 217, 262, 167, 234, 208, 256, 245, 250, 219, 271.
Host load average (1 min) at each window end: 14.1, 17.6, 17.9, 17.6, 20.2, 20.4, 21.3, 17.9, 14.8, 14.2, 13.2, 12.3 (16 cores). Dips in throughput that line up with a high load are the host, not the app.

Mean latency (ms) per window by request type:

| Type | w1 | w2 | w3 | w4 | w5 | w6 | w7 | w8 | w9 | w10 | w11 | w12 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| send | 91.97 | 109.39 | 103.07 | 91.35 | 139.5 | 95.31 | 108.13 | 92.13 | 96.29 | 92.8 | 104.52 | 85.02 |
| preview | 94.67 | 107.8 | 107.58 | 88.48 | 141.67 | 100.25 | 113.68 | 90.36 | 96.68 | 93.91 | 107.67 | 87.08 |
| read | 91.68 | 106.02 | 107.11 | 87.51 | 140.6 | 98.96 | 111.59 | 91 | 94.57 | 90.68 | 106.71 | 85.16 |
| capture | 142.93 | 157.86 | 163.13 | 143.96 | 197.64 | 147.43 | 166.67 | 139.33 | 152.98 | 149.57 | 164.38 | 136.46 |
| sendBody | 94.02 | 107.15 | 113.46 | 89.9 | 138.19 | 101.03 | 115.66 | 93.75 | 92.89 | 89.22 | 101.06 | 86.78 |
| large | 91.88 | 108.52 | 105.45 | 92.12 | 137.25 | 102.08 | 114.59 | 89.51 | 94.9 | 99.43 | 106.09 | 85.04 |
| previewBody | 97.46 | 100.76 | 111.27 | 88.39 | 133.38 | 99.67 | 117.23 | 91.87 | 94.99 | 96.31 | 115.54 | 89.22 |

Overall: PASS
