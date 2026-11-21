# Go examples

This module holds runnable examples and the conformance fixture. It depends on every Go adapter and on the SQLite, PostgreSQL, MySQL and SQL Server drivers and GORM dialectors, so the core module stays dependency-free.

| Path | What it is |
| --- | --- |
| `quickstart/` | A minimal `net/http` and `database/sql` API with Sendproof mounted. |
| `fixture/` | The conformance fixture from `spec/conformance/fixture.md`, bound to net/http, chi, Gin and Echo, each over database/sql or GORM. |
| `cmd/fixture/` | The fixture's executable: `fixture [nethttp\|chi\|gin\|echo] [sql\|gorm]`. |
| `tests/` | Go tests for the provider, redaction, savepoints and every framework and store pairing. |

## Run the quickstart

From a fresh clone, with no Go installed:

```sh
adapters/go/scripts/setup-go.sh
cd adapters/go/examples
../scripts/go.sh run ./quickstart
```

Open `http://localhost:8080/dev` once to sign in as the example developer, which redirects to `/sendproof/`. Select **Create an item** and use **Preview**. The Database panel shows the inserted row, Side effects shows the held email, and `GET /items/{id}` still returns 404. **Send** the same request to persist it.

## Run the conformance suite

```sh
adapters/go/scripts/build-fixture.sh
node tests/conformance/run.mjs go-net-http go-gorm                  # SQLite
node tests/conformance/run.mjs go-net-http-postgresql go-gorm-mysql # server engines, with BENCH_POSTGRES_URL etc. set
```

The Go profiles are `go-net-http`, `go-chi`, `go-gin`, `go-echo` and `go-gorm` on SQLite, and `go-net-http-{postgresql,mysql,sqlserver}` and `go-gorm-{postgresql,mysql,sqlserver}`.

The fixture reads `PORT`, `BENCH_PATH_BASE` and `BENCH_SCENARIO` (`standard`, `disabled`, `no-provider`, `rollback-failure`) and mounts everything under the path base. Requests outside the base receive 404. `BENCH_DATABASE` selects `sqlite` (default, a file in `BENCH_TMP_DIR`), `postgresql`, `mysql` or `sqlserver`; server engines connect to the fresh, empty database in `BENCH_DATABASE_URL` (`postgresql://`, `mysql://` or `mssql://`) and create the `items` table themselves.

## Run the provider tests on every database

The tests in `tests/` always run on SQLite. They also run on PostgreSQL, MySQL and SQL Server when these variables point at disposable servers; each test creates a database with a random name and drops it afterwards:

```sh
export BENCH_POSTGRES_URL=postgresql://user:pass@127.0.0.1:5432/postgres
export BENCH_MYSQL_URL=mysql://root:pass@127.0.0.1:3306/mysql
export BENCH_SQLSERVER_URL='mssql://sa:pass@127.0.0.1:1433/master?encrypt=false&trustServerCertificate=true'
../scripts/go.sh test ./tests/
```

On 2026-11-20 the suite ran with the race detector against SQLite, PostgreSQL 17, MySQL 8.4 and SQL Server 2022: 29 tests per engine (19 provider scenarios, 8 framework and store pairings, 2 rollback-failure stores), with the upsert scenario skipped on SQL Server (no single-statement upsert besides MERGE), plus 2 engine-specific tests. All 11 Go conformance profiles passed their 11 checks each (121 of 121).
