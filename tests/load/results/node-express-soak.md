# Load result: node-express (soak)

Machine: Apple M4 Max, 16 cores, 48 GiB, Darwin 25.5.0 arm64, Node v24.5.0. Started 2026-11-21T12:59:55.253Z.

Fixture start command: `node adapters/node/examples/fixture.mjs express`.

## Idle overhead (bench disabled vs enabled; median of 8 alternating 1500 ms bursts)

| Route | Disabled rps | Enabled rps | Ratio | Disabled p50/p99 ms | Enabled p50/p99 ms | Errors |
| --- | --- | --- | --- | --- | --- | --- |
| ready@1 | 20738.3 | 20828.3 | 1.004 | 0.04 / 0.13 | 0.04 / 0.12 | 0 |
| ready@16 | 54608.8 | 54571.9 | 0.999 | 0.27 / 0.65 | 0.27 / 0.61 | 0 |
| read@1 | 14932.3 | 15034.9 | 1.007 | 0.06 / 0.14 | 0.06 / 0.14 | 0 |
| read@16 | 37269 | 38306.3 | 1.028 | 0.37 / 0.98 | 0.37 / 1.05 | 0 |
| write@1 | 15819.3 | 16447.1 | 1.04 | 0.06 / 0.11 | 0.06 / 0.11 | 0 |
| write@16 | 37634.8 | 37633.3 | 1 | 0.38 / 0.91 | 0.37 / 0.92 | 0 |
| send@1 | - | 13725.6 | - | - | 0.07 / 0.12 | 0 |
| send@16 | - | 30491.8 | - | - | 0.46 / 1.81 | 0 |
| observedSend@1 | - | 9300.3 | - | - | 0.09 / 0.22 | 0 |
| observedSend@16 | - | 16528.1 | - | - | 0.83 / 4.35 | 0 |
| preview@1 | - | 8417.7 | - | - | 0.1 / 0.25 | 0 |
| preview@16 | - | 14049.9 | - | - | 1 / 4.76 | 0 |

## Preview and observed Send at concurrency 32: PASS

| Check | Requests | rps | p50 / p95 / p99 ms | Failed | Left behind / missing |
| --- | --- | --- | --- | --- | --- |
| previewDistinctIds | 1000 | 8666.4 | 2.65 / 4.93 / 39.43 | 0 | 0 |
| previewSameId | 1000 | 11836.1 | 2.43 / 3.91 / 4.97 | 0 | 0 |
| previewSameRow | 1000 | 13106.9 | 2.22 / 4.27 / 4.64 | 0 | 0 |
| observedSend | 500 | 13028 | 2.14 / 3.99 / 4.32 | 0 | 0 |

Traces issued 500, still readable 8, misattributed 0.

## Memory soak, 300s at concurrency 24: BOUNDED

| Start MiB | Mid-run median | Final median | Growth MiB | Slope MiB/min | Peak MiB | Idle after settle MiB |
| --- | --- | --- | --- | --- | --- | --- |
| 362.8 | 386.3 | 410.5 | 24.2 | 7.56 | 417.8 | 370.1 |

Load: 800330 requests, 2667.7 rps, p50/p95/p99 7.8 / 19.32 / 26.68 ms, 0 failed (0%). Statuses: {"200":560583,"201":199591,"413":40156}.
Throughput per 25s window (rps): 2821, 2863, 2850, 2716, 2781, 2797, 2720, 2712, 2273, 2547, 2626, 2307.

Mean latency (ms) per window by request type:

| Type | w1 | w2 | w3 | w4 | w5 | w6 | w7 | w8 | w9 | w10 | w11 | w12 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sendBody | 8.67 | 8.63 | 8.59 | 9 | 8.86 | 8.73 | 9 | 8.83 | 11.05 | 9.57 | 9.3 | 10.63 |
| read | 8.11 | 7.99 | 8.06 | 8.45 | 8.33 | 8.17 | 8.49 | 8.33 | 10.45 | 8.98 | 8.76 | 10.07 |
| send | 8.16 | 8.06 | 8.08 | 8.39 | 8.32 | 8.24 | 8.43 | 8.43 | 10.53 | 9.01 | 8.75 | 9.92 |
| preview | 8.16 | 8.01 | 8.06 | 8.55 | 8.24 | 8.25 | 8.46 | 8.4 | 10.1 | 9.11 | 8.77 | 9.99 |
| capture | 12.18 | 11.91 | 11.99 | 12.45 | 12.14 | 12.34 | 12.54 | 12.5 | 15.06 | 13.48 | 12.96 | 14.32 |
| previewBody | 8.67 | 8.64 | 8.67 | 9.04 | 8.93 | 8.81 | 8.95 | 9.02 | 10.76 | 9.45 | 9.24 | 10.64 |
| large | 9.46 | 9.23 | 9.37 | 9.64 | 9.33 | 9.46 | 9.72 | 9.63 | 11.09 | 10.36 | 10.1 | 11.24 |

Overall: PASS
