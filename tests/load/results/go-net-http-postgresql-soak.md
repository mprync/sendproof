# Load result: go-net-http-postgresql (soak)

Machine: Apple M4 Max, 16 cores, 48 GiB, Darwin 25.5.0 arm64, Node v24.5.0. Started 2026-11-21T15:02:20.389Z.

Fixture start command: `artifacts/go/fixture nethttp sql`.

## Preview and observed Send at concurrency 32: PASS

| Check | Requests | rps | p50 / p95 / p99 ms | Failed | Left behind / missing |
| --- | --- | --- | --- | --- | --- |
| previewDistinctIds | 1000 | 163.5 | 165.41 / 346.1 / 699.3 | 0 | 0 |
| previewSameId | 1000 | 162.8 | 181.81 / 293.61 / 389.22 | 0 | 0 |
| previewSameRow | 1000 | 208.4 | 142.42 / 228.8 / 293.18 | 0 | 0 |
| observedSend | 500 | 3415.1 | 8.43 / 14.18 / 19.84 | 0 | 0 |

Traces issued 500, still readable 8, misattributed 0.

## PostgreSQL lock contention: PASS

| Condition | Traffic | Requests | rps | p50 / p95 / p99 ms | max ms | Failed | Lock waiters max / mean |
| --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | hotUpdate | 145790 | 9719.1 | 0.76 / 1.26 / 1.82 | 18.41 | 0 | 7 / 0.41 |
| baseline | insert | 160981 | 10724.6 | 0.69 / 1.11 / 1.64 | 19.24 | 0 | 7 / 0.41 |
| baseline | read | 160140 | 10660.7 | 0.7 / 1.1 / 1.59 | 21.93 | 0 | 7 / 0.41 |
| disjointRows@4 | hotUpdate | 6427 | 428.1 | 18.63 / 23.19 / 35.59 | 58.73 | 0 | 19 / 17.01 |
| disjointRows@4 | insert | 6457 | 430.1 | 18.62 / 23 / 34.99 | 62.13 | 0 | 19 / 17.01 |
| disjointRows@4 | read | 163289 | 10885.2 | 0.67 / 1.21 / 1.77 | 18.91 | 0 | 19 / 17.01 |
| disjointRows@4 | previews | 2310 | 153.8 | 25.28 / 30.85 / 42.03 | 54.35 | 0 | 19 / 17.01 |
| hotRow@4 | hotUpdate | 7211 | 479.2 | 15.79 / 28.24 / 65.17 | 113.24 | 0 | 19 / 16.64 |
| hotRow@4 | insert | 7251 | 481.7 | 15.71 / 28.59 / 63.22 | 108.75 | 0 | 19 / 16.64 |
| hotRow@4 | read | 147178 | 9809.7 | 0.68 / 1.49 / 2.99 | 38.84 | 0 | 19 / 16.64 |
| hotRow@4 | previews | 2301 | 152.9 | 23.03 / 40.91 / 88.08 | 152.15 | 0 | 19 / 16.64 |
| longPreviews@4 | hotUpdate | 75 | 4.6 | 676.3 / 7950.03 / 7953.89 | 7953.89 | 0 | 19 / 18.62 |
| longPreviews@4 | insert | 78 | 4.8 | 672.61 / 7949.9 / 7954.92 | 7954.92 | 0 | 19 / 18.62 |
| longPreviews@4 | read | 24548 | 1527.9 | 1.05 / 11.4 / 65.47 | 2534.26 | 0 | 19 / 18.62 |
| longPreviews@4 | previews | 17 | 1.1 | 3263.95 / 8347.74 / 8347.74 | 8347.74 | 4 | 19 / 18.62 |
| hotRow@16 | hotUpdate | 1077 | 70.4 | 82.57 / 243.94 / 593.76 | 1561.87 | 0 | 19 / 17.69 |
| hotRow@16 | insert | 1068 | 69.8 | 83.25 / 237.09 / 651.18 | 1681.78 | 0 | 19 / 17.69 |
| hotRow@16 | read | 2468 | 163.8 | 29.05 / 135.73 / 294.73 | 1642.19 | 0 | 19 / 17.69 |
| hotRow@16 | previews | 1965 | 128.4 | 90.15 / 241.01 / 672.44 | 1706.88 | 0 | 19 / 17.69 |
| longPreviews@16 | hotUpdate | 84 | 5.2 | 1405.41 / 4501.4 / 6308.14 | 6308.14 | 0 | 19 / 18.27 |
| longPreviews@16 | insert | 100 | 6.1 | 1205.57 / 4164.32 / 4872.45 | 5714.07 | 0 | 19 / 18.27 |
| longPreviews@16 | read | 191 | 12.2 | 353.45 / 2316.07 / 3191.99 | 4050.57 | 0 | 19 / 18.27 |
| longPreviews@16 | previews | 127 | 7.6 | 1814.29 / 3462.45 / 4068.09 | 4184.17 | 0 | 19 / 18.27 |

| Same-key insert | Requests | p50 | p95 | p99 | max |
| --- | --- | --- | --- | --- | --- |
| alone | 200 | 0.92 | 1.38 | 1.63 | 1.68 |
| racing a Preview | 200 | 2.43 | 4.48 | 4.87 | 5.2 |

- Errors under Preview load (longPreviews@4): previews 4/17

Overall: PASS
