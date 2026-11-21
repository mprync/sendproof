# Load result: python-flask-sqlalchemy-postgresql (soak)

Machine: Apple M4 Max, 16 cores, 48 GiB, Darwin 25.5.0 arm64, Node v24.5.0. Started 2026-11-21T15:06:17.918Z.

Fixture start command: `adapters/python/.venv/bin/python adapters/python/conformance/fixture_flask_sqlalchemy.py`.

## Preview and observed Send at concurrency 32: PASS

| Check | Requests | rps | p50 / p95 / p99 ms | Failed | Left behind / missing |
| --- | --- | --- | --- | --- | --- |
| previewDistinctIds | 1000 | 444.7 | 3.54 / 71.39 / 96.87 | 0 | 0 |
| previewSameId | 1000 | 399.6 | 3.83 / 6.19 / 7.81 | 0 | 0 |
| previewSameRow | 1000 | 399.6 | 4.15 / 9.85 / 18.62 | 0 | 0 |
| observedSend | 500 | 398.9 | 2.99 / 3.86 / 4.48 | 0 | 0 |

Traces issued 500, still readable 8, misattributed 0.

## PostgreSQL lock contention: PASS

| Condition | Traffic | Requests | rps | p50 / p95 / p99 ms | max ms | Failed | Lock waiters max / mean |
| --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | hotUpdate | 2000 | 132.9 | 2.88 / 4.73 / 10.59 | 26 | 0 | 0 / 0 |
| baseline | insert | 2015 | 133.8 | 1.43 / 2.35 / 5.84 | 19.78 | 0 | 0 / 0 |
| baseline | read | 2008 | 133.6 | 1.43 / 2.47 / 5.16 | 18.04 | 0 | 0 / 0 |
| disjointRows@4 | hotUpdate | 1715 | 113.9 | 2.55 / 3.82 / 10.4 | 104.87 | 0 | 0 / 0 |
| disjointRows@4 | insert | 1727 | 114.6 | 1.26 / 1.83 / 4.9 | 92.53 | 0 | 0 / 0 |
| disjointRows@4 | read | 1719 | 114.2 | 1.25 / 1.88 / 6.5 | 92.03 | 0 | 0 / 0 |
| disjointRows@4 | previews | 853 | 56.6 | 3.38 / 5.17 / 14.4 | 128.21 | 0 | 0 / 0 |
| hotRow@4 | hotUpdate | 1720 | 114.2 | 2.5 / 3.68 / 5.9 | 16.18 | 0 | 1 / 0 |
| hotRow@4 | insert | 1728 | 114.8 | 1.28 / 1.83 / 2.33 | 10.32 | 0 | 1 / 0 |
| hotRow@4 | read | 1721 | 114.3 | 1.3 / 1.84 / 2.23 | 6.02 | 0 | 1 / 0 |
| hotRow@4 | previews | 858 | 56.9 | 3.62 / 5.38 / 8.82 | 14.91 | 0 | 1 / 0 |
| longPreviews@4 | hotUpdate | 1697 | 112.7 | 6.49 / 14 / 20.89 | 35.76 | 0 | 0 / 0 |
| longPreviews@4 | insert | 1772 | 117.6 | 2.54 / 7.38 / 14.34 | 22.55 | 0 | 0 / 0 |
| longPreviews@4 | read | 1767 | 117.4 | 2.55 / 7.74 / 13.11 | 18.5 | 0 | 0 / 0 |
| longPreviews@4 | previews | 788 | 52.4 | 12.42 / 32.49 / 52.56 | 94.45 | 0 | 0 / 0 |
| hotRow@16 | hotUpdate | 809 | 53.5 | 2.85 / 335.01 / 1350.73 | 3064.46 | 0 | 13 / 3.06 |
| hotRow@16 | insert | 897 | 59.5 | 1.47 / 269.13 / 999.08 | 1986.35 | 0 | 13 / 3.06 |
| hotRow@16 | read | 904 | 60 | 1.48 / 275.27 / 1042.48 | 1824.52 | 0 | 13 / 3.06 |
| hotRow@16 | previews | 1605 | 106.2 | 3.97 / 289.97 / 1268.51 | 2837.78 | 0 | 13 / 3.06 |
| longPreviews@16 | hotUpdate | 821 | 54.3 | 127.15 / 297.87 / 437.74 | 552.9 | 0 | 2 / 0.02 |
| longPreviews@16 | insert | 903 | 59.8 | 110.7 / 284.2 / 420.73 | 854.44 | 0 | 2 / 0.02 |
| longPreviews@16 | read | 897 | 59.5 | 107.77 / 293.62 / 410.96 | 505.02 | 0 | 2 / 0.02 |
| longPreviews@16 | previews | 557 | 36.6 | 421.86 / 603.63 / 723.24 | 945.8 | 0 | 2 / 0.02 |

| Same-key insert | Requests | p50 | p95 | p99 | max |
| --- | --- | --- | --- | --- | --- |
| alone | 200 | 2.56 | 3.29 | 3.91 | 4.32 |
| racing a Preview | 200 | 3.52 | 9.05 | 12.17 | 13.57 |

Overall: PASS
