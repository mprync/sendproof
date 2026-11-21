# Load and performance harness

One command measures one conformance binding:

```sh
node tests/load/run.mjs <binding-id> [--profile quick|soak] [--only idle,concurrency,soak,contention] [--prepare]
node tests/load/summary.mjs soak     # cross-binding tables from tests/load/results
```

It starts the binding's fixture with the conformance host (`tests/conformance/host.mjs`), so readiness, ports and disposable
databases behave exactly as in the conformance runner. It needs only Node; there are no extra dependencies. Results are
written to `tests/load/results/<id>-<profile>.json` and a readable `.md` next to it.

| Phase | Question it answers |
| --- | --- |
| `idle` | What does the bench cost an ordinary route? Compares the same app with the bench disabled (the production default) and enabled, running both at once and alternating short bursts so machine noise hits both sides equally. Also measures Preview, plain Send and observed Send. |
| `concurrency` | Do concurrent Previews all roll back, stay isolated from each other, and do concurrent observed Sends each commit once? Reports latency and error rate. |
| `soak` | Does resident memory stay bounded under a sustained mixed workload that includes bodies near the capture limits, capture overflow and oversize responses? Samples the fixture's whole process group. |
| `contention` | PostgreSQL bindings only: what does a running Preview do to concurrent ordinary traffic on the same table (row locks, unique-key waits, pool pressure)? Samples `pg_stat_activity` for lock waiters. |

Profiles are in `profiles.json`. `quick` takes a couple of minutes per binding; `soak` runs the 5-minute memory soak and the longer
latency runs used for `docs/performance.md`. `overrides` in the same file swap in optimized builds for load runs (Rust release,
the JVM with full tiered compilation).

For PostgreSQL bindings the harness starts a throwaway `postgres:17-alpine` container (`sendproof-load-postgres`, port 55433, data
on tmpfs) and removes it afterwards. Set `BENCH_POSTGRES_URL` to use an existing server instead.

Exit status is non-zero when a correctness check fails (a Preview that persisted, saw another Preview's write, or failed; an observed
Send that did not commit once), when memory keeps growing, or when ordinary traffic fails with no Preview load.

## Knobs and diagnostics

- Every soak window records the host's 1-minute load average, and every result records it before and after each phase. A dip in
  throughput that lines up with a load above the core count is the machine, not the app.
- When requests fail during the soak, the result keeps the end of the fixture's own log (for example a database lock timeout).
- `BENCH_JAVA_OPTS=-Xmx512m` passes JVM options to the Spring fixture, to check that its memory growth is heap ergonomics.
- `BENCH_SQLITE_CONNECTIONS=1` sets the Rust fixture's SQLite pool size (default 8).
- `--out <directory>` writes results somewhere other than `tests/load/results`.
- Idle and soak tolerate fewer than 1 failed request per 1,000 (SQLite lock timeouts); Preview and Send correctness checks do not.

Results and findings are summarised in [docs/performance.md](../../docs/performance.md).
