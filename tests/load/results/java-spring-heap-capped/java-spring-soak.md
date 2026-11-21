# Load result: java-spring (soak)

Machine: Apple M4 Max, 16 cores, 48 GiB, Darwin 25.5.0 arm64, Node v24.5.0. Started 2026-11-21T16:27:36.878Z.

Fixture start command: `sh -c . adapters/java/scripts/jdk.sh && exec java $BENCH_JAVA_OPTS -jar examples/java-spring-fixture/build/libs/test-bench-java-fixture.jar`.

## Memory soak, 300s at concurrency 24: BOUNDED

| Start MiB | Mid-run median | Final median | Growth MiB | Slope MiB/min | Peak MiB | Idle after settle MiB |
| --- | --- | --- | --- | --- | --- | --- |
| 777.2 | 900.1 | 901.9 | 1.8 | 0.74 | 901.9 | 901.8 |

Load: 3906441 requests, 13020.9 rps, p50/p95/p99 1.08 / 6.72 / 14.36 ms, 0 failed (0%). Statuses: {"200":2735345,"201":975290,"413":195806}.
Throughput per 25s window (rps): 13600, 13616, 12850, 12526, 12652, 13314, 12957, 11237, 13154, 13755, 13182, 13404.
Host load average (1 min) at each window end: 21.9, 24.1, 24.8, 24.4, 25.2, 27.3, 24, 24.6, 26.9, 22.6, 28.3, 26.1 (16 cores). Dips in throughput that line up with a high load are the host, not the app.

Mean latency (ms) per window by request type:

| Type | w1 | w2 | w3 | w4 | w5 | w6 | w7 | w8 | w9 | w10 | w11 | w12 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| read | 1.11 | 1.1 | 1.18 | 1.22 | 1.2 | 1.12 | 1.16 | 1.36 | 1.13 | 1.08 | 1.13 | 1.1 |
| preview | 1.24 | 1.23 | 1.33 | 1.39 | 1.37 | 1.26 | 1.32 | 1.57 | 1.28 | 1.22 | 1.27 | 1.24 |
| send | 1.2 | 1.18 | 1.29 | 1.33 | 1.32 | 1.22 | 1.26 | 1.5 | 1.23 | 1.16 | 1.21 | 1.19 |
| sendBody | 1.37 | 1.35 | 1.45 | 1.51 | 1.5 | 1.39 | 1.43 | 1.68 | 1.38 | 1.33 | 1.37 | 1.35 |
| previewBody | 1.4 | 1.4 | 1.5 | 1.57 | 1.54 | 1.43 | 1.47 | 1.74 | 1.44 | 1.38 | 1.42 | 1.38 |
| large | 1.99 | 1.96 | 2.08 | 2.12 | 2.1 | 1.99 | 2.03 | 2.37 | 2.01 | 1.91 | 1.98 | 1.94 |
| capture | 11.04 | 11.2 | 11.49 | 11.65 | 11.56 | 11.44 | 11.6 | 12.6 | 11.67 | 11.32 | 11.86 | 11.88 |

Host load average (1 min) before / after each phase on 16 cores: soak 21.4 / 22.9. A load above the core count means other work competed with the run.

Overall: PASS
