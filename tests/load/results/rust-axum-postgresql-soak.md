# Load result: rust-axum-postgresql (soak)

Machine: Apple M4 Max, 16 cores, 48 GiB, Darwin 25.5.0 arm64, Node v24.5.0. Started 2026-11-21T15:04:16.096Z.

Fixture start command: `adapters/rust/target/release/rust-conformance`.

## Preview and observed Send at concurrency 32: PASS

| Check | Requests | rps | p50 / p95 / p99 ms | Failed | Left behind / missing |
| --- | --- | --- | --- | --- | --- |
| previewDistinctIds | 1000 | 241 | 130.36 / 150.62 / 164.91 | 0 | 0 |
| previewSameId | 1000 | 205.3 | 131.54 / 264.43 / 552.22 | 0 | 0 |
| previewSameRow | 1000 | 201.2 | 141.22 / 245.42 / 376.58 | 0 | 0 |
| observedSend | 500 | 557.7 | 51.92 / 82.79 / 104.2 | 0 | 0 |

Traces issued 500, still readable 8, misattributed 0.

## PostgreSQL lock contention: PASS

| Condition | Traffic | Requests | rps | p50 / p95 / p99 ms | max ms | Failed | Lock waiters max / mean |
| --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | hotUpdate | 36914 | 2460.1 | 3.05 / 4.5 / 6.24 | 18.4 | 0 | 1 / 0.01 |
| baseline | insert | 37228 | 2481.4 | 3.03 / 4.45 / 6.22 | 18.53 | 0 | 1 / 0.01 |
| baseline | read | 37138 | 2474.6 | 3.04 / 4.46 / 6.19 | 18.56 | 0 | 1 / 0.01 |
| disjointRows@4 | hotUpdate | 6110 | 407.2 | 12.82 / 38.85 / 193.14 | 1070.19 | 0 | 7 / 3.56 |
| disjointRows@4 | insert | 6208 | 413.7 | 12.43 / 38.66 / 201.73 | 1090.28 | 0 | 7 / 3.56 |
| disjointRows@4 | read | 6381 | 425.3 | 12 / 36.64 / 177.31 | 1038.77 | 0 | 7 / 3.56 |
| disjointRows@4 | previews | 1501 | 99.9 | 25.17 / 67.85 / 489.19 | 1424.06 | 0 | 7 / 3.56 |
| hotRow@4 | hotUpdate | 9458 | 630.4 | 11.6 / 24.67 / 32.54 | 109.51 | 0 | 7 / 3.68 |
| hotRow@4 | insert | 9613 | 640.7 | 11.31 / 24.38 / 32.4 | 108.85 | 0 | 7 / 3.68 |
| hotRow@4 | read | 9882 | 658.6 | 10.21 / 22.66 / 29.86 | 107.44 | 0 | 7 / 3.68 |
| hotRow@4 | previews | 2306 | 153.5 | 24.51 / 37.07 / 47.57 | 120.72 | 0 | 7 / 3.68 |
| longPreviews@4 | hotUpdate | 556 | 36.5 | 138.22 / 521.16 / 572.98 | 653.17 | 0 | 7 / 6.73 |
| longPreviews@4 | insert | 570 | 37.4 | 114.45 / 527.13 / 649.57 | 653.18 | 0 | 7 / 6.73 |
| longPreviews@4 | read | 585 | 38.4 | 129.47 / 519.82 / 647.32 | 652.89 | 0 | 7 / 6.73 |
| longPreviews@4 | previews | 129 | 8.4 | 464.21 / 654.57 / 781.47 | 805.09 | 0 | 7 / 6.73 |
| hotRow@16 | hotUpdate | 1090 | 72.3 | 79.57 / 408.23 / 650.41 | 1019.79 | 0 | 7 / 5.12 |
| hotRow@16 | insert | 1090 | 72.3 | 79.77 / 408.07 / 650.93 | 1010.29 | 0 | 7 / 5.12 |
| hotRow@16 | read | 1219 | 80.9 | 74.71 / 346.7 / 618.3 | 695.49 | 0 | 7 / 5.12 |
| hotRow@16 | previews | 2069 | 137.2 | 83.74 / 355.63 / 771.28 | 1020.01 | 0 | 7 / 5.12 |
| longPreviews@16 | hotUpdate | 80 | 4.8 | 1828.65 / 1975.27 / 1975.79 | 1975.79 | 0 | 7 / 6.82 |
| longPreviews@16 | insert | 80 | 4.8 | 1828.6 / 1974.85 / 1975.4 | 1975.4 | 0 | 7 / 6.82 |
| longPreviews@16 | read | 80 | 4.8 | 1828.82 / 1974.17 / 1974.9 | 1974.9 | 0 | 7 / 6.82 |
| longPreviews@16 | previews | 145 | 8.6 | 1819.92 / 2252.97 / 2541.48 | 2653.16 | 0 | 7 / 6.82 |

| Same-key insert | Requests | p50 | p95 | p99 | max |
| --- | --- | --- | --- | --- | --- |
| alone | 200 | 1.94 | 2.47 | 9.88 | 9.94 |
| racing a Preview | 200 | 34.89 | 301.57 | 871.69 | 915.64 |

Overall: PASS
