# Performance

What Test Bench costs an application, how it behaves under load, and the limits we recommend. Every number here comes from
the load harness in [`tests/load`](../tests/load/README.md) and can be reproduced with one command per binding.

## Summary

- **The bench is free when it is off and unmeasurable when it is on.** Ordinary routes run at the same speed with the bench
  disabled (the production default) and enabled. Differences are inside run-to-run noise (about ±10%).
- **Memory stays flat.** All eight runtimes held bounded memory through a 5-minute mixed workload of about 20 thousand to
  3.9 million requests each, including capture overflow and oversize responses. No leak was found.
- **Preview and observed Send stay correct under concurrency.** Across every binding, 0 Previews persisted, leaked into another
  Preview, or failed; every observed Send committed exactly once and no trace was misattributed.
- **The expensive cases are database locks, not the bench code.** PostgreSQL providers that install row triggers (Go, Rust)
  take a table lock for the length of each Preview, which stalls ordinary writes. SQLite allows one writer at a time.
  [Guidance](#recommended-limits) covers both.

## Method

The harness starts each binding's conformance fixture exactly as the conformance runner does, then drives it with a
closed-loop HTTP client (a fixed number of in-flight requests, keep-alive connections, plain `node:http`, no dependencies).
Four phases run per binding:

| Phase | What it measures |
| --- | --- |
| Idle overhead | The same app with the bench disabled and enabled, run side by side in alternating short bursts so machine noise hits both equally. Also times Preview, plain Send and observed Send. |
| Concurrency | 1,000 Previews (distinct ids, same id, same row) and 500 observed Sends at concurrency 32. Checks isolation, rollback and that each Send commits once. |
| Soak | 5 minutes at concurrency 24 with a mixed workload: Preview and observed Send writes, reads, a Preview that overflows the change, effect and log limits, a Preview whose response exceeds the 1 MiB capture limit, and bodies of about 92 KB. Resident memory of the whole process group is sampled every 5 seconds. |
| Contention (PostgreSQL) | What running Previews do to ordinary traffic on the same table: row locks, unique-key waits and pool pressure. Lock waiters are sampled from `pg_stat_activity`. |

Latency is measured per request from write to the last response byte. Percentiles are nearest-rank.

### Builds that were measured

Optimised builds only: Rust `--release`, .NET `Release`, Go's default optimised build, and the Spring Boot jar on a JIT-warmed
JVM. Node, Python and Ruby run their normal interpreters. Two fixtures are not production servers and are called out in the
results: **PHP** runs under `php -S` (one process, one request at a time) and **Rails** runs in development mode with Puma
(1 to 4 threads). Read their numbers as a lower bound for those stacks.

### Machine

Apple M4 Max, 16 cores, 48 GiB, macOS (Darwin 25.5.0, arm64), Node 24.5. The load driver, the fixture and Docker Desktop
(PostgreSQL 17 on tmpfs) share this one machine, so absolute numbers are lower than a dedicated server and **other work on the
machine affected some windows**. The harness now records the 1-minute load average at every window, and the raw results keep
it. See [host load](#host-load-explains-the-throughput-dips). Runs date from 2026-11-21.

## Results

### Idle overhead of the bench

Throughput with the bench enabled divided by throughput with it disabled, median of 8 alternating 1.5-second bursts. A value of
1.0 means no cost. Values between 0.9 and 1.1 are noise: the bursts themselves vary by about that much.

| Binding | ready@1 | read@1 | write@1 | ready@16 | read@16 | write@16 |
| --- | --- | --- | --- | --- | --- | --- |
| .NET (ASP.NET Core) | 1.01 | 1.00 | 1.02 | 1.01 | 1.00 | 1.04 |
| Go (net/http) | 0.99 | 0.99 | 0.93 | 1.00 | 1.02 | 1.00 |
| JVM (Spring Boot) | 0.93 | 1.01 | 0.89 | 0.96 | 1.02 | 0.97 |
| Node (Express) | 1.00 | 1.01 | 1.04 | 1.00 | 1.03 | 1.00 |
| PHP (Laravel) | 0.96 | 0.97 | 1.10 | 0.90 | 0.89 | 1.03 |
| Python (FastAPI) | 1.01 | 1.04 | 1.05 | 1.01 | 0.96 | 0.98 |
| Ruby (Rails) | 0.95 | 1.07 | 0.87 | 0.92 | 0.93 | 0.99 |
| Rust (Axum) | 1.00 | 0.93 | 1.06 | 0.96 | 0.96 | 1.14 |

Median latency (ms) at concurrency 1, bench disabled / enabled:

| Binding | Health check | Read | Write |
| --- | --- | --- | --- |
| .NET | 0.05 / 0.05 | 0.40 / 0.40 | 0.90 / 0.89 |
| Go | 0.04 / 0.04 | 0.05 / 0.05 | 0.07 / 0.09 |
| JVM | 0.05 / 0.05 | 0.06 / 0.06 | 0.07 / 0.07 |
| Node | 0.04 / 0.04 | 0.06 / 0.06 | 0.06 / 0.06 |
| PHP (`php -S`) | 2.91 / 2.91 | 6.09 / 6.31 | 4.51 / 4.31 |
| Python | 0.31 / 0.31 | 0.60 / 0.55 | 0.79 / 0.78 |
| Ruby (dev mode) | 0.34 / 0.34 | 0.59 / 0.59 | 0.71 / 0.76 |
| Rust | 0.03 / 0.03 | 0.05 / 0.06 | 0.09 / 0.10 |

### Preview and Send latency

Concurrency 16, bench enabled. Each cell is throughput, then p50 / p95 / p99 latency in milliseconds. "Send" is an ordinary
write; "observed Send" commits and records a trace; "Preview" runs and rolls back. All use SQLite (JVM: H2) in the fixture.

| Binding | Send | Observed Send | Preview |
| --- | --- | --- | --- |
| .NET | 3,048 rps, 0.46 / 6.9 / 304 | 2,796 rps, 0.49 / 5.0 / 155 | 2,646 rps, 0.29 / 0.39 / 152 |
| Go | 8,185 rps, 0.10 / 3.2 / 33 | 7,593 rps, 0.13 / 8.2 / 53 | 12,422 rps, 0.10 / 3.2 / 33 |
| JVM | 34,697 rps, 0.32 / 0.96 / 2.5 | 37,169 rps, 0.36 / 0.87 / 1.3 | 40,676 rps, 0.41 / 0.71 / 1.2 |
| Node | 30,492 rps, 0.46 / 0.91 / 1.8 | 16,528 rps, 0.83 / 1.7 / 4.4 | 14,050 rps, 1.0 / 2.0 / 4.8 |
| PHP (`php -S`) | 241 rps, 63 / 73 / 75 | 196 rps, 86 / 97 / 102 | 213 rps, 72 / 92 / 119 |
| Python | 1,450 rps, 7.4 / 26 / 101 | 1,210 rps, 9.5 / 28 / 100 | 888 rps, 3.1 / 68 / 360 |
| Ruby (dev mode) | 979 rps, 14.6 / 29 / 47 | 661 rps, 20 / 68 / 240 | 772 rps, 19.9 / 28 / 47 |
| Rust | 8,986 rps, 0.92 / 2.3 / 15 | 8,687 rps, 1.3 / 15 / 49 | 4,985 rps, 1.7 / 2.2 / 2.6 |

The 150 to 300 ms p99 values for .NET and the 33 ms for Go are SQLite write-lock waits at 16 writers, not bench work: they
also appear on the bench-disabled side of the idle comparison.

### Correctness and isolation under concurrency

All twelve fixtures tested (the eight above plus four PostgreSQL fixtures) passed: 3,000 Previews at concurrency 32 per binding
with 0 failures and 0 rows left behind, 500 observed Sends with 0 missing commits, 0 misattributed traces. Latency at
concurrency 32 (p50 / p95 / p99 ms, Preview with distinct ids):

| Binding | Preview, distinct ids | Observed Send |
| --- | --- | --- |
| .NET | 10.6 / 80 / 624 | 0.5 / 162 / 463 |
| Go | 0.16 / 18 / 79 | 0.17 / 33 / 136 |
| JVM | 7.5 / 27 / 173 | 3.5 / 22 / 29 |
| Node | 2.7 / 4.9 / 39 | 2.1 / 4.0 / 4.3 |
| PHP | 136 / 155 / 181 | 143 / 184 / 199 |
| Python | 19 / 64 / 498 | 19 / 42 / 166 |
| Ruby | 46 / 61 / 68 | 49 / 130 / 162 |
| Rust | 4.5 / 5.2 / 27 | 4.1 / 6.4 / 44 |
| Go + PostgreSQL | 165 / 346 / 699 | 8.4 / 14 / 20 |
| Node (Drizzle) + PostgreSQL | 19 / 30 / 38 | 12.8 / 16.6 / 17.5 |
| Python (Flask, SQLAlchemy) + PostgreSQL | 3.5 / 71 / 97 | 3.0 / 3.9 / 4.5 |
| Rust + PostgreSQL | 130 / 151 / 165 | 52 / 83 / 104 |

The trace store stays bounded: 8 of 500 issued traces remained readable, as designed.

### Memory soak

Five minutes at concurrency 24. Resident memory (MiB) of the fixture's whole process group; the verdict compares a mid-run
window with the final one.

| Binding | Start | Peak | Final | After 15 s idle | Requests | rps | p50 / p95 / p99 ms | Failed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| .NET | 386 | 474 | 437 | 423 | 586,758 | 1,954 | 0.5 / 6.0 / 304 | 0 |
| Go | 53 | 57 | 57 | 53 | 1,024,945 | 3,416 | 0.28 / 21 / 114 | 0 |
| JVM (default heap) | 1,545 | 3,055 | 3,009 | 3,015 | 2,436,006 | 8,120 | 1.3 / 10 / 21 | 0 |
| JVM (`-Xmx512m`) | 777 | 902 | 902 | 902 | 3,906,441 | 13,021 | 1.1 / 6.7 / 14 | 0 |
| Node | 363 | 418 | 411 | 370 | 800,330 | 2,668 | 7.8 / 19 / 27 | 0 |
| PHP (`php -S`) | 51 | 53 | 53 | 53 | 17,749 | 59 | 226 / 1,167 / 4,107 | 0 |
| Python | 98 | 120 | 119 | 120 | 210,908 | 703 | 14.8 / 96 / 493 | 0 |
| Ruby (dev mode) | 144 | 159 | 126 | 142 | 69,959 | 233 | 79 / 234 / 395 | 0 |
| Rust | 31 | 35 | 31 | 31 | 647,560 | 2,157 | 6.1 / 24 / 98 | 0 |

Every run was judged **bounded**. The JVM's 3 GiB is its heap growing to fit a 48 GiB machine, not a leak; see
[the JVM finding](#the-jvm-uses-the-heap-it-is-given).

### PostgreSQL lock contention

Ordinary traffic (hot-row update, inserts, reads) while Previews run on the same table, each fixture using its own connection pool (Go 24 connections, Rust 8).
Hot-row update p50 / p99 in milliseconds:

| Condition | Go | Rust | Node (Drizzle) | Python (SQLAlchemy) |
| --- | --- | --- | --- | --- |
| No Previews | 0.76 / 1.8 | 3.1 / 6.2 | 2.0 / 9.3 | 2.9 / 11 |
| 4 Previews inserting other rows | 19 / 36 | 13 / 193 | 2.3 / 6.4 | 2.6 / 10 |
| 4 Previews updating the same row | 16 / 65 | 12 / 33 | 8.4 / 26 | 2.5 / 5.9 |
| 4 Previews of a 200-row operation | **676 / 7,954** | 138 / 573 | 2.6 / 4.9 | 6.5 / 21 |
| 16 Previews updating the same row | 83 / 594 | 80 / 650 | 31 / 58 | 2.9 / 1,351 |
| 16 Previews of a 200-row operation | 1,405 / 6,308 | 1,829 / 1,976 | 500 / 1,694 | 127 / 438 |
| Ordinary insert of a key a Preview inserts (alone / racing) | 0.9 / 2.4 | 1.9 / 35 | 1.3 / 7.5 | 2.6 / 3.5 |

Isolation held in every condition: no ordinary read ever returned a Preview's value.

## Findings

### Rust soak: no collapse reproduced, the dips follow host load

An interrupted run reported Rust throughput falling from about 2,400 rps to about 5 rps. We could not reproduce it. Five release-build
soaks of five minutes each (one with the fixture's SQLite pool forced to one connection) never fell below 580 rps in any
25-second window; memory was flat (31 to 37 MiB) and 99.9999% of requests succeeded.

What the data shows:

- In every dip, **all request types slowed together**, including plain reads and the 413 responses that touch no database. An
  operation that degrades (a leak, a growing structure) would slow one type or grow steadily. A process stalled from outside
  slows everything at once.
- The dips line up with the host's load average rising above the core count (for example 830 rps in the window where load
  reached 18 on 16 cores).
- The Rust binding already has a regression test for the related SQLite behaviour:
  `concurrent_sqlite_previews_queue_for_the_write_lock_instead_of_failing` in `adapters/rust/testbench-sqlx/tests/preview.rs`.

**Verdict: a host and harness artefact, not a binding bug.** The raw data of the original run was lost when its session
ended, so the 5 rps figure itself is unexplained; the harness now records host load per window and keeps the end of the fixture
log when requests fail, so a recurrence is diagnosable.

### Host load explains the throughput dips

The machine ran other builds and tests during these measurements (1-minute load average between 6 and 75 on 16 cores).
Early runs taken at the highest load showed PHP at 26 rps, .NET at 609 rps and Python with 125 failed requests; rerunning on
a calmer machine gave 59, 1,954 and 0 (the .NET and Python changes below also contributed). Treat any single 25-second window
with a load above 16 as suspect. The soak report prints the load next to the throughput series.

### SQLite allows one writer, and the default journal mode makes it worse

Under 24 concurrent writers, three fixtures hit `database is locked`:

| Fixture | Before | After | Change |
| --- | --- | --- | --- |
| Python (FastAPI) | 5, 15 and 125 failed requests per soak | 0 | Fixture enables write-ahead logging (WAL) |
| .NET | Send at concurrency 16: 67 rps, p95 1.7 s; soak 1,110 rps | 3,048 rps, p95 6.9 ms; soak 1,954 rps | Fixture enables WAL |
| Rust | 0 to 3 failed requests per 600,000 | unchanged | Already WAL; waits time out after the 5 s busy timeout |

The default rollback journal blocks readers while a writer commits and fsyncs twice per commit, and SQLite waits for the
lock by sleeping and polling rather than queueing. WAL lets readers and the writer proceed together. Go and Rust fixtures
were already configured this way. This is a property of SQLite, not of the bench, and it also occurs with the bench disabled.

Test Bench itself is correct here: Preview opens its SQLite transaction with `BEGIN IMMEDIATE`, so concurrent Previews queue
for the write lock instead of failing on a lock upgrade.

### PostgreSQL Previews that install triggers lock tables

The Go provider (and the Rust SQLx provider) capture changes with row triggers that exist only inside the Preview's
transaction. Creating a trigger takes a `SHARE ROW EXCLUSIVE` lock on the table until the Preview ends, so **every Preview
stalls ordinary writes to the instrumented tables, and Previews queue behind each other**. With four concurrent 200-row
Previews, Go's ordinary hot-row update went from 0.8 ms to a 7.9 s p99. This is the documented design (see the comment at the
top of `adapters/go/dbsql/postgres.go`), not a defect, and reads are not affected. The Node (Drizzle) and Python (SQLAlchemy)
providers capture in the application and take no table lock, so ordinary traffic barely notices.

### The JVM uses the heap it is given

With the default heap limit (a quarter of the machine's 48 GiB) the JVM grew to 3 GiB and then stayed flat. Capping the heap
at 512 MiB (`BENCH_JAVA_OPTS=-Xmx512m`) held resident memory at 902 MiB and throughput rose to 13,021 rps with p99 14 ms, so
the live data is small and there is no leak. Set `-Xmx` (or container memory limits the JVM respects) in production.

### Fixture notes

- PHP's `php -S` serves one request at a time, so its soak (59 rps at concurrency 24) measures that server, not Laravel or the
  bench. Use PHP-FPM to size a real deployment.
- Rails ran in development mode.
- Go's PostgreSQL fixture uses a fixed pool of 24 connections (`database/sql` keeps only two idle connections by default, so
  concurrent requests would otherwise reconnect almost every time).

## Recommended limits

| Area | Recommendation | Why |
| --- | --- | --- |
| Concurrent Previews per instance | At most the size of the database connection pool (8 in the fixtures) | Each Preview holds a connection for the whole request; more only queue. |
| PostgreSQL with Go or Rust | Point Preview at a dedicated development or staging database, never a database serving production writes | A Preview locks instrumented tables for its duration (seconds for large operations). |
| PostgreSQL with Node or Python | Safe next to ordinary traffic; keep operations short | No table locks; only row locks the operation itself takes. |
| SQLite | Enable WAL and a busy timeout of at least 5 s; expect rare lock timeouts above about 16 concurrent writers | One writer at a time; polling lock waits are not fair. |
| JVM | Set `-Xmx` | Heap otherwise grows to a quarter of host memory. |
| Request and response sizes | Keep Preview bodies under the framework's 100 KB default and responses under 1 MiB | Larger responses are refused with 413 and cost the full request. All bindings handled 92 KB bodies and oversize responses with bounded memory. |
| Enabling in production | Leave the bench disabled by default | Disabled and enabled are indistinguishable in throughput, but disabled removes the Preview surface entirely. |

## Reproduce

```sh
node tests/load/run.mjs rust-axum --profile soak          # one binding, all phases (about 10 minutes)
node tests/load/run.mjs go-net-http-postgresql --profile soak --only concurrency,contention
BENCH_JAVA_OPTS=-Xmx512m node tests/load/run.mjs java-spring --profile soak --only soak
node tests/load/summary.mjs soak                          # cross-binding tables from tests/load/results
```

Raw results (JSON and Markdown, including per-window throughput, per-type latency and host load) are in
[`tests/load/results`](../tests/load/results). The JVM heap-capped run is in `tests/load/results/java-spring-heap-capped`.
Run on an otherwise idle machine for comparable numbers.
