# Load result: node-express-drizzle-postgresql (soak)

Machine: Apple M4 Max, 16 cores, 48 GiB, Darwin 25.5.0 arm64, Node v24.5.0. Started 2026-11-21T15:00:26.950Z.

Fixture start command: `node adapters/node/examples/fixture.mjs drizzle`.

## Preview and observed Send at concurrency 32: PASS

| Check | Requests | rps | p50 / p95 / p99 ms | Failed | Left behind / missing |
| --- | --- | --- | --- | --- | --- |
| previewDistinctIds | 1000 | 1501.2 | 19.35 / 29.8 / 38.42 | 0 | 0 |
| previewSameId | 1000 | 682.9 | 44.81 / 61.85 / 75.86 | 0 | 0 |
| previewSameRow | 1000 | 458.1 | 62.99 / 89.91 / 215.54 | 0 | 0 |
| observedSend | 500 | 2383.7 | 12.81 / 16.61 / 17.53 | 0 | 0 |

Traces issued 500, still readable 8, misattributed 0.

## PostgreSQL lock contention: PASS

| Condition | Traffic | Requests | rps | p50 / p95 / p99 ms | max ms | Failed | Lock waiters max / mean |
| --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | hotUpdate | 47935 | 3194.7 | 1.95 / 5.57 / 9.31 | 125.29 | 0 | 3 / 0.07 |
| baseline | insert | 49106 | 3273.4 | 1.9 / 5.42 / 9.22 | 124.82 | 0 | 3 / 0.07 |
| baseline | read | 48617 | 3239.6 | 1.92 / 5.45 / 9.13 | 123.09 | 0 | 3 / 0.07 |
| disjointRows@4 | hotUpdate | 46920 | 3126.9 | 2.32 / 3.92 / 6.4 | 108.59 | 0 | 4 / 0.04 |
| disjointRows@4 | insert | 47543 | 3167.9 | 2.29 / 3.88 / 6.29 | 108.78 | 0 | 4 / 0.04 |
| disjointRows@4 | read | 47260 | 3150.2 | 2.3 / 3.91 / 6.34 | 108.49 | 0 | 4 / 0.04 |
| disjointRows@4 | previews | 9328 | 621.4 | 5.87 / 9.74 / 14.63 | 112.05 | 0 | 4 / 0.04 |
| hotRow@4 | hotUpdate | 13602 | 906.3 | 8.4 / 13.7 / 25.75 | 158.11 | 0 | 7 / 4.83 |
| hotRow@4 | insert | 22673 | 1511.1 | 4.81 / 8.24 / 15.71 | 121.71 | 0 | 7 / 4.83 |
| hotRow@4 | read | 22587 | 1505.5 | 4.83 / 8.24 / 15.54 | 120.77 | 0 | 7 / 4.83 |
| hotRow@4 | previews | 5703 | 380 | 9.72 / 15.1 / 28.38 | 157.75 | 0 | 7 / 4.83 |
| longPreviews@4 | hotUpdate | 44033 | 2934 | 2.57 / 3.4 / 4.9 | 143.36 | 0 | 3 / 0.03 |
| longPreviews@4 | insert | 44632 | 2975 | 2.54 / 3.36 / 4.87 | 143.6 | 0 | 3 / 0.03 |
| longPreviews@4 | read | 44254 | 2949.3 | 2.56 / 3.38 / 4.87 | 142.75 | 0 | 3 / 0.03 |
| longPreviews@4 | previews | 172 | 11.4 | 347.7 / 386.55 / 421.01 | 425 | 0 | 3 / 0.03 |
| hotRow@16 | hotUpdate | 3681 | 244.9 | 30.98 / 43.48 / 57.96 | 119.98 | 0 | 7 / 6.05 |
| hotRow@16 | insert | 4086 | 272.4 | 28.24 / 41.84 / 56.21 | 120.03 | 0 | 7 / 6.05 |
| hotRow@16 | read | 4056 | 270.2 | 28.44 / 42.2 / 55.85 | 120.1 | 0 | 7 / 6.05 |
| hotRow@16 | previews | 7338 | 488.2 | 31.11 / 44.25 / 57.51 | 125.03 | 0 | 7 / 6.05 |
| longPreviews@16 | hotUpdate | 208 | 13.5 | 500.4 / 1385.35 / 1694.03 | 1694.65 | 0 | 0 / 0 |
| longPreviews@16 | insert | 207 | 13 | 441.21 / 1315.85 / 1944.91 | 1945.42 | 0 | 0 / 0 |
| longPreviews@16 | read | 202 | 12.7 | 448.42 / 1315.17 / 1947.44 | 1948.53 | 0 | 0 / 0 |
| longPreviews@16 | previews | 240 | 15.1 | 854.22 / 2041.92 / 2192.71 | 2229.75 | 0 | 0 / 0 |

| Same-key insert | Requests | p50 | p95 | p99 | max |
| --- | --- | --- | --- | --- | --- |
| alone | 200 | 1.26 | 1.64 | 1.74 | 1.78 |
| racing a Preview | 200 | 7.47 | 13.59 | 14.47 | 14.73 |

Overall: PASS
