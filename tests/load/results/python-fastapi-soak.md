# Load result: python-fastapi (soak)

Machine: Apple M4 Max, 16 cores, 48 GiB, Darwin 25.5.0 arm64, Node v24.5.0. Started 2026-11-21T16:07:32.529Z.

Fixture start command: `adapters/python/.venv/bin/python adapters/python/conformance/fixture_fastapi.py`.

## Idle overhead (bench disabled vs enabled; median of 8 alternating 1500 ms bursts)

| Route | Disabled rps | Enabled rps | Ratio | Disabled p50/p99 ms | Enabled p50/p99 ms | Errors |
| --- | --- | --- | --- | --- | --- | --- |
| ready@1 | 3109.6 | 3148 | 1.012 | 0.31 / 0.47 | 0.31 / 0.46 | 0 |
| ready@16 | 5964.4 | 5994.6 | 1.005 | 2.6 / 3.77 | 2.58 / 3.74 | 0 |
| read@1 | 1691.9 | 1765.5 | 1.044 | 0.6 / 1.15 | 0.55 / 1.31 | 0 |
| read@16 | 2171.5 | 2089.1 | 0.962 | 7.47 / 14.84 | 7.67 / 16.73 | 0 |
| write@1 | 1190.6 | 1250.6 | 1.05 | 0.79 / 1.18 | 0.78 / 1.13 | 0 |
| write@16 | 1611 | 1572.7 | 0.976 | 4.89 / 165.41 | 4.62 / 153.6 | 0 |
| send@1 | - | 1109.5 | - | - | 0.85 / 1.44 | 0 |
| send@16 | - | 1450.3 | - | - | 7.36 / 100.56 | 0 |
| observedSend@1 | - | 1007.4 | - | - | 0.96 / 1.27 | 0 |
| observedSend@16 | - | 1210 | - | - | 9.54 / 99.9 | 0 |
| preview@1 | - | 810.5 | - | - | 1.21 / 1.85 | 0 |
| preview@16 | - | 887.6 | - | - | 3.12 / 359.87 | 0 |

## Preview and observed Send at concurrency 32: PASS

| Check | Requests | rps | p50 / p95 / p99 ms | Failed | Left behind / missing |
| --- | --- | --- | --- | --- | --- |
| previewDistinctIds | 1000 | 835 | 18.96 / 63.99 / 497.79 | 0 | 0 |
| previewSameId | 1000 | 773.6 | 19.38 / 59.52 / 591.7 | 0 | 0 |
| previewSameRow | 1000 | 864.8 | 17.44 / 83.13 / 395.57 | 0 | 0 |
| observedSend | 500 | 1072 | 19.25 / 42.42 / 165.76 | 0 | 0 |

Traces issued 500, still readable 8, misattributed 0.

## Memory soak, 300s at concurrency 24: BOUNDED

| Start MiB | Mid-run median | Final median | Growth MiB | Slope MiB/min | Peak MiB | Idle after settle MiB |
| --- | --- | --- | --- | --- | --- | --- |
| 97.5 | 110.5 | 119 | 8.5 | 2.68 | 120.1 | 120.1 |

Load: 210908 requests, 702.5 rps, p50/p95/p99 14.81 / 96.15 / 493.28 ms, 0 failed (0%). Statuses: {"200":147692,"201":52558,"413":10658}.
Throughput per 25s window (rps): 746, 743, 648, 673, 675, 689, 668, 673, 724, 720, 731, 746.
Host load average (1 min) at each window end: 5.4, 8.8, 17, 23, 17.2, 19.3, 23, 24.4, 18.3, 15.5, 18.2, 20.6 (16 cores). Dips in throughput that line up with a high load are the host, not the app.

Mean latency (ms) per window by request type:

| Type | w1 | w2 | w3 | w4 | w5 | w6 | w7 | w8 | w9 | w10 | w11 | w12 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| read | 12.05 | 12.09 | 13.81 | 13.22 | 13.12 | 12.94 | 13.62 | 13.29 | 12.37 | 12.51 | 12.24 | 11.98 |
| preview | 37 | 37.86 | 41.93 | 41.74 | 42.31 | 40.44 | 42.85 | 44.74 | 41.13 | 39.04 | 39.38 | 37.68 |
| sendBody | 37.7 | 39.8 | 41.48 | 39.38 | 41.96 | 46.72 | 42.38 | 41.95 | 41.32 | 45.18 | 37.54 | 41.01 |
| previewBody | 38.17 | 45.47 | 49.95 | 46.58 | 40.73 | 48.27 | 38.64 | 40.45 | 41.18 | 35.86 | 45.21 | 32.22 |
| send | 38.92 | 39.67 | 48.16 | 47.65 | 43.89 | 40.44 | 41.61 | 41.1 | 36.37 | 38.93 | 37.05 | 39.47 |
| capture | 41.86 | 43.45 | 61.29 | 44.86 | 58.3 | 50.84 | 61.62 | 48.04 | 47.3 | 43.8 | 45.78 | 48.95 |
| large | 47.48 | 35.76 | 40.16 | 43.95 | 37.29 | 34.33 | 41.05 | 35.53 | 35.13 | 41.85 | 40.04 | 37.89 |

Host load average (1 min) before / after each phase on 16 cores: idle 8.9 / 5.3, concurrency 5.3 / 5.6, soak 5.6 / 25.1. A load above the core count means other work competed with the run.

Overall: PASS
