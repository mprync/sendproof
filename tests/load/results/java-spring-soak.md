# Load result: java-spring (soak)

Machine: Apple M4 Max, 16 cores, 48 GiB, Darwin 25.5.0 arm64, Node v24.5.0. Started 2026-11-21T14:06:54.656Z.

Fixture start command: `sh -c . adapters/java/scripts/jdk.sh && exec java -jar examples/java-spring-fixture/build/libs/test-bench-java-fixture.jar`.

## Idle overhead (bench disabled vs enabled; median of 8 alternating 1500 ms bursts)

| Route | Disabled rps | Enabled rps | Ratio | Disabled p50/p99 ms | Enabled p50/p99 ms | Errors |
| --- | --- | --- | --- | --- | --- | --- |
| ready@1 | 17991.5 | 16800.7 | 0.934 | 0.05 / 0.19 | 0.05 / 0.21 | 0 |
| ready@16 | 47410.4 | 45648.4 | 0.963 | 0.28 / 1.04 | 0.28 / 1.1 | 0 |
| read@1 | 13198.6 | 13364.4 | 1.013 | 0.06 / 0.43 | 0.06 / 0.23 | 0 |
| read@16 | 40095.2 | 40677.6 | 1.015 | 0.29 / 1.58 | 0.29 / 1.16 | 0 |
| write@1 | 11454.5 | 10155 | 0.887 | 0.07 / 0.31 | 0.07 / 0.46 | 0 |
| write@16 | 43454.5 | 41942.4 | 0.965 | 0.3 / 1.45 | 0.29 / 1.24 | 0 |
| send@1 | - | 9335.9 | - | - | 0.09 / 1.81 | 0 |
| send@16 | - | 34697.4 | - | - | 0.32 / 2.5 | 0 |
| observedSend@1 | - | 6169.7 | - | - | 0.12 / 2.1 | 0 |
| observedSend@16 | - | 37168.9 | - | - | 0.36 / 1.34 | 0 |
| preview@1 | - | 5639.4 | - | - | 0.15 / 0.41 | 0 |
| preview@16 | - | 40675.7 | - | - | 0.41 / 1.17 | 0 |

## Preview and observed Send at concurrency 32: PASS

| Check | Requests | rps | p50 / p95 / p99 ms | Failed | Left behind / missing |
| --- | --- | --- | --- | --- | --- |
| previewDistinctIds | 1000 | 2153.3 | 7.5 / 27.45 / 172.98 | 0 | 0 |
| previewSameId | 1000 | 2069.2 | 13.2 / 40.8 / 52.04 | 0 | 0 |
| previewSameRow | 1000 | 3944.3 | 6.55 / 18.37 / 24.28 | 0 | 0 |
| observedSend | 500 | 5873.3 | 3.5 / 22.29 / 29.48 | 0 | 0 |

Traces issued 500, still readable 8, misattributed 0.

## Memory soak, 300s at concurrency 24: BOUNDED

| Start MiB | Mid-run median | Final median | Growth MiB | Slope MiB/min | Peak MiB | Idle after settle MiB |
| --- | --- | --- | --- | --- | --- | --- |
| 1544.6 | 2708 | 3008.9 | 300.9 | -60.48 | 3055.3 | 3015 |

Load: 2436006 requests, 8119.9 rps, p50/p95/p99 1.31 / 10.35 / 21.18 ms, 0 failed (0%). Statuses: {"200":1705744,"201":608179,"413":122083}.
Throughput per 25s window (rps): 10109, 11178, 11229, 7882, 10061, 8425, 6569, 6949, 6398, 5986, 7225, 5427.
Host load average (1 min) at each window end: 15.9, 17.2, 15.8, 57.3, 44.6, 36.3, 46.8, 37.5, 33.5, 42, 38.5, 35.5 (16 cores). Dips in throughput that line up with a high load are the host, not the app.

Mean latency (ms) per window by request type:

| Type | w1 | w2 | w3 | w4 | w5 | w6 | w7 | w8 | w9 | w10 | w11 | w12 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| read | 1.5 | 1.37 | 1.38 | 2.07 | 1.53 | 1.93 | 2.45 | 2.37 | 2.63 | 2.76 | 2.14 | 3.17 |
| send | 1.7 | 1.56 | 1.53 | 2.28 | 1.72 | 2.22 | 3.04 | 2.67 | 3.11 | 3.12 | 2.62 | 3.77 |
| preview | 1.83 | 1.61 | 1.58 | 2.5 | 1.86 | 2.32 | 3.06 | 2.82 | 3.23 | 3.4 | 2.76 | 3.91 |
| sendBody | 2 | 1.71 | 1.76 | 2.82 | 2.09 | 2.42 | 3.02 | 2.94 | 3.38 | 3.7 | 2.79 | 4.1 |
| previewBody | 2.11 | 1.78 | 1.81 | 2.4 | 1.91 | 2.65 | 3.16 | 3.06 | 3.48 | 3.79 | 2.76 | 4.23 |
| large | 2.54 | 2.25 | 2.71 | 3.08 | 2.81 | 3.09 | 4.16 | 4.78 | 4.11 | 4.53 | 4.11 | 4.66 |
| capture | 12.89 | 11.89 | 12.34 | 13.86 | 13.3 | 13.53 | 15.88 | 15.68 | 15.25 | 17.01 | 15.65 | 16.28 |

Overall: PASS
