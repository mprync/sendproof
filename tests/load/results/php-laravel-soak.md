# Load result: php-laravel (soak)

Machine: Apple M4 Max, 16 cores, 48 GiB, Darwin 25.5.0 arm64, Node v24.5.0. Started 2026-11-21T15:29:17.661Z.

Fixture start command: `php adapters/php/examples/laravel-fixture/serve.php`.

## Idle overhead (bench disabled vs enabled; median of 8 alternating 1500 ms bursts)

| Route | Disabled rps | Enabled rps | Ratio | Disabled p50/p99 ms | Enabled p50/p99 ms | Errors |
| --- | --- | --- | --- | --- | --- | --- |
| ready@1 | 202 | 192.9 | 0.955 | 2.91 / 6.08 | 2.91 / 5.09 | 0 |
| ready@16 | 374 | 337.9 | 0.903 | 36.65 / 69.57 | 40.5 / 125.1 | 0 |
| read@1 | 104.8 | 101.8 | 0.971 | 6.09 / 33.58 | 6.31 / 29.65 | 0 |
| read@16 | 313.1 | 279 | 0.891 | 51.74 / 68.98 | 53.66 / 98.66 | 0 |
| write@1 | 136.6 | 149.9 | 1.097 | 4.51 / 25.82 | 4.31 / 11.64 | 0 |
| write@16 | 283.5 | 291.7 | 1.029 | 55.25 / 89.16 | 51.91 / 76.32 | 0 |
| send@1 | - | 153.3 | - | - | 4.18 / 6.43 | 0 |
| send@16 | - | 241.2 | - | - | 62.81 / 75.15 | 0 |
| observedSend@1 | - | 124.3 | - | - | 5.73 / 18.87 | 0 |
| observedSend@16 | - | 195.5 | - | - | 86.43 / 101.86 | 0 |
| preview@1 | - | 139.1 | - | - | 4.89 / 9.61 | 0 |
| preview@16 | - | 213 | - | - | 71.55 / 118.59 | 0 |

## Preview and observed Send at concurrency 32: PASS

| Check | Requests | rps | p50 / p95 / p99 ms | Failed | Left behind / missing |
| --- | --- | --- | --- | --- | --- |
| previewDistinctIds | 1000 | 230.9 | 135.83 / 155.38 / 180.83 | 0 | 0 |
| previewSameId | 1000 | 258.2 | 117.35 / 146.82 / 159.82 | 0 | 0 |
| previewSameRow | 1000 | 259.8 | 121.64 / 134.63 / 151.79 | 0 | 0 |
| observedSend | 500 | 206.7 | 142.66 / 184.19 / 199.15 | 0 | 0 |

Traces issued 500, still readable 8, misattributed 0.

## Memory soak, 300s at concurrency 24: BOUNDED

| Start MiB | Mid-run median | Final median | Growth MiB | Slope MiB/min | Peak MiB | Idle after settle MiB |
| --- | --- | --- | --- | --- | --- | --- |
| 51.4 | 51.9 | 52.5 | 0.5 | 0.18 | 52.5 | 52.5 |

Load: 17749 requests, 59.1 rps, p50/p95/p99 226.47 / 1166.74 / 4107.16 ms, 0 failed (0%). Statuses: {"200":12392,"201":4515,"413":842}.
Throughput per 25s window (rps): 90, 58, 62, 60, 61, 72, 65, 51, 51, 59, 46, 33.
Host load average (1 min) at each window end: 13.1, 14.6, 10.9, 9.9, 8.5, 8.5, 10.3, 13.6, 11.2, 11.3, 12.6, 13.5 (16 cores). Dips in throughput that line up with a high load are the host, not the app.

Mean latency (ms) per window by request type:

| Type | w1 | w2 | w3 | w4 | w5 | w6 | w7 | w8 | w9 | w10 | w11 | w12 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| preview | 238.07 | 393.65 | 385.35 | 344.07 | 338.35 | 306.55 | 352.32 | 442.41 | 448.77 | 370.5 | 530.08 | 667.01 |
| capture | 314.45 | 564.15 | 465.43 | 370.52 | 690.33 | 559.57 | 517.45 | 611.06 | 532.9 | 562.06 | 753.57 | 895.52 |
| read | 232.54 | 437.81 | 320.55 | 374.49 | 334.81 | 304.22 | 322.74 | 477.09 | 460.62 | 381.58 | 523.46 | 630.69 |
| send | 232.61 | 447.93 | 331.64 | 543.26 | 331.07 | 321.04 | 377.33 | 379.64 | 438.99 | 417.48 | 506.64 | 823.16 |
| large | 220.51 | 259.91 | 256.22 | 586.64 | 539.89 | 284.87 | 264.02 | 424.57 | 313.74 | 310.14 | 368.73 | 593.75 |
| sendBody | 277.21 | 480.21 | 378.5 | 544.33 | 514.07 | 360.08 | 420.21 | 594.8 | 489.01 | 409.44 | 549.17 | 852.8 |
| previewBody | 261.36 | 585.81 | 311.03 | 542.16 | 487.91 | 457.53 | 462.55 | 607.48 | 651.67 | 511.73 | 564.57 | 940.56 |

Host load average (1 min) before / after each phase on 16 cores: idle 8.4 / 18.6, concurrency 15.7 / 14, soak 14.1 / 15.8. A load above the core count means other work competed with the run.

Overall: PASS
