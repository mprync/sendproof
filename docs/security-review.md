# Security review: sign-in, Preview and observed Send

Review date: 21 November 2026. Scope: the protocol in `spec/`, the shared conformance suite in `tests/conformance/`, and all eight bindings (.NET, Node, Python, JVM, Go, PHP, Ruby, Rust) with their fixtures and the Treasury example.

## Summary

The review found **70 issues: 0 Critical, 16 High, 22 Medium and 32 Low**. Every finding in the tables below is fixed, and each fix has a regression test. Smaller gaps that were deliberately left as they are, with the reason, are listed in [Accepted risks](#accepted-risks).

Two problems appeared in almost every binding:

- **A handler could commit a Preview.** A raw `COMMIT`, a driver-level commit, MySQL DDL that commits implicitly, or a write on another pooled connection made Preview writes permanent. In several bindings the Preview still answered `rolledBack: true`.
- **Change snapshots exposed secrets.** Columns such as `password_hash`, `api_key` and `*_token` appeared in plain text in `key`, `before` and `after`. This happened even where SQL parameter values were already redacted.

| Binding | High | Medium | Low |
| --- | --- | --- | --- |
| .NET (ASP.NET Core, EF Core, Treasury example) | 1 | 1 | 1 |
| Node (Express, Fastify, Hono, NestJS; SQLite, Knex, TypeORM, Prisma, Drizzle) | 3 | 4 | 3 |
| Python (FastAPI, Flask, Django; SQLAlchemy, Django ORM) | 3 | 4 | 4 |
| Go (net/http, chi, Gin, Echo; database/sql, GORM) | 3 | 4 | 6 |
| JVM (Spring Boot, Ktor; JDBC, JPA) | 1 | 3 | 5 |
| PHP (Laravel, Symfony) | 0 | 4 | 4 |
| Ruby (Rails, ActiveRecord) | 1 | 0 | 3 |
| Rust (Axum, Actix; SQLx) | 4 | 2 | 5 |
| Rust conformance fixture | 0 | 0 | 1 |
| **Total** | **16** | **22** | **32** |

Severity scale:

- **Critical:** exploitable in a default production setup.
- **High:** a Preview can persist data, or secrets leak to workbench users, under ordinary development use.
- **Medium:** needs a specific host setup, or weakens a documented guarantee.
- **Low:** hardening, or a gap with little practical impact.

## How the review was done

1. The spec and the .NET reference adapter were read in full. Their behaviour was turned into a checklist covering sign-in and authorization, CSRF and origin, preview rollback and transport, traces, capture limits, secret handling and the SQL the adapters build themselves.
2. Each other binding was compared against that checklist, looking for the places where it behaves differently from the reference. Every binding was reviewed independently, and every finding was fixed in that binding with a local regression test.
3. Rules that apply to every binding were added to the shared HTTP suite (`tests/conformance/protocol.mjs`), so all bindings must pass them. They are listed in [Rules added to the shared conformance suite](#rules-added-to-the-shared-conformance-suite).
4. The spec now states those rules too: `spec/README.md` covers the preview target and origin rules, hop-by-hop headers, credential leakage, trace origin and trace ID entropy. `spec/conformance/fixture.md` covers rejected sign-in.

## Findings

Each table lists the severity, the binding, where the fix lives, the issue, the fix and the regression test. Paths are relative to the repository root unless the row names an adapter directory.

### A handler could commit or outlive a Preview

Preview depends on every write the handler makes staying inside the transaction that Sendproof rolls back. These findings are ways out of that transaction. Each one is now refused before it reaches the driver, or detected so that the Preview fails with HTTP 500 and no envelope. A refused statement fails the Preview even when the handler catches the error.

| ID | Sev | Binding | Location | Issue | Fix | Test |
| --- | --- | --- | --- | --- | --- | --- |
| NODE-1 | High | Node TypeORM | `adapters/node/typeorm/src/index.ts:183,209` | `commitTransaction()` or a raw `COMMIT`/`END` persisted writes. On PostgreSQL and MySQL the Preview was still confirmed as rolled back. | Outermost commits and transaction-ending SQL are refused. A nested `manager.transaction()` still works as a savepoint. | `adapters/node/tests/typeorm.test.mjs` "refuses to let the handler commit…" |
| NODE-2 | High | Node TypeORM on SQLite | `adapters/node/typeorm/src/index.ts:212` | Work still running after the response ended early (size limit, client abort) autocommitted on the shared SQLite runner. | Any statement after the Preview scope ends is refused. | `typeorm.test.mjs` "work that outlives an early-settled Preview…" |
| NODE-3 | High | Node Knex | `adapters/node/knex/src/tracked.ts:115`, `index.ts:222` | `client.commit()` and a raw `COMMIT` escaped the Preview transaction. | The Preview transaction is wrapped so both are refused, and a refused Preview fails. | `knex.test.mts` "refuses to let the operation commit…" |
| NODE-4 | Medium | Node TypeORM (pooled) | `adapters/node/typeorm/src/index.ts:209` | Writes through `source.manager` ran on another pooled connection, outside the Preview. | Writes on any other connection are refused during a Preview. | `typeorm.test.mjs` "a write through another pooled connection…" (PostgreSQL, MySQL) |
| NODE-7 | Medium | Node Drizzle, Prisma | `adapters/node/core/src/statements.ts:15`, `drizzle/src/index.ts:184` | A MySQL executable comment `/*!COMMIT*/` got past the guard. In Drizzle, a refused COMMIT that the handler caught still let the Preview be confirmed. | One shared statement classifier in core, which removed the duplicate Prisma copy. Drizzle fails a refused Preview. | `core-protocol.test.mjs` "the shared statement classifier…"; `drizzle.test.mts` "refuses statements…" |
| PY-3 | High | Python SQLAlchemy, Django ORM | `adapters/python/core/src/sendproof_core/txguard.py`; `sqlalchemy/.../provider.py:116`, `connection.py:89,102`; `django/.../orm.py:79` | A raw `COMMIT`, a `RELEASE` of the guard savepoint, a switch to autocommit, or MySQL/Oracle DDL committed for real. This was confirmed on SQLite, PostgreSQL and MySQL. | These are refused before they reach the driver, and the Preview answers 500. | `test_fastapi_security.py::test_handler_commit_*`; Flask and Django `test_raw_commit_*`; `test_core.py::test_transaction_guard_*` |
| PY-7 | Medium | Python (all frameworks) | `adapters/python/fastapi/.../middleware.py:229`; `core/.../sync_engine.py:185` | A `BaseException` (cancellation, client abort, `SystemExit`, `gevent.Timeout`) skipped the rollback and the close. | Roll back and close, then re-raise. | FastAPI `test_aborted_*`; Flask `test_interrupted_*` |
| GO-1 | High | Go on MySQL | `adapters/go/dbsql/lexer.go:79` | MySQL runs the contents of `/*! … */` and `/*M! … */` comments, but the guard skipped them, so `/*! COMMIT */` escaped the rollback. | The lexer reads those comment bodies as SQL. | `dbsql/internal_test.go::TestPreviewGuardSeesThroughQuotingAndComments` |
| GO-2 | High | Go on SQL Server | `adapters/go/dbsql/classify.go:267` | A batch that starts with a bare name runs it as a procedure, so `sp_executesql N'COMMIT'` got past the guard. | Such batches are refused. | same test |
| GO-4 | Medium | Go (all) | `adapters/go/dbsql/scope.go:339,536,596` | If the handler ignored the refusal of a raw COMMIT, the Preview was still confirmed. | A refusal fails the whole Preview with 500. | `examples/tests/dbsql_test.go::TestTransactionControlIsRefused` |
| GO-5 | Medium | Go on MySQL, PostgreSQL | `adapters/go/dbsql/classify.go:203` | The guard assumed backslash escapes on MySQL and none on PostgreSQL. Under `NO_BACKSLASH_ESCAPES`, `ANSI_QUOTES` or `standard_conforming_strings=off`, a COMMIT could hide inside what the guard took for a string literal. | Both readings are checked, and either one refuses. MySQL `--` now needs a following space. | GO-1 test |
| GO-8 | Low | Go on MySQL, SQLite | `adapters/go/dbsql/classify.go:245,302` | `SET PASSWORD`, `SET DEFAULT ROLE`, `LOAD INDEX`, `ATTACH`, `DETACH` and `VACUUM` were allowed. | All are refused. | GO-1 test |
| JVM-2 | Medium | Spring, Ktor | `adapters/java/sendproof-jdbc/.../PreviewConnectionGuard.java:16`, `JdbcCaptureListener.java:47`, `SharedConnection.java:33`; `sendproof-jpa/.../JpaConnectionGuard.java:16`; `sendproof-core/.../TransactionControl.java:30` | A raw `COMMIT`, DDL, `Statement.getConnection().commit()`, `unwrap` or `Connection.commit()` persisted writes while the Preview was still confirmed. | All are refused while the handler runs. Savepoints still work. | `JdbcPreviewTest::transactionControlAndDdlStatementsAreRefused`, `::aCommitReachedThroughTheStatementIsRefusedAndFailsThePreview`, `::unwrappingToTheDriverConnectionIsRefused`; `JpaPreviewTest::aDirectConnectionCommitIsRefused…` |
| PHP-3 | Medium | Laravel | `adapters/php/laravel/src/Eloquent/EloquentSession.php:43,79` | After a raw `COMMIT`, Laravel skipped the rollback without an error and the Preview reported `rolledBack: true`. | The session asks the driver whether the transaction is still open, and refuses to confirm (500) if it is not. | `adapters/php/laravel/tests/SecurityTest.php::testARawCommitIsNeverConfirmedAsARollback` |
| RS-1 | High | Rust (MySQL worst) | `adapters/rust/sendproof-sqlx/src/query.rs:221,426` | `COMMIT`, `ROLLBACK`, `BEGIN`, `SET autocommit`, `CALL` or MySQL DDL ran inside a Preview and made earlier writes permanent. | Named queries that end the transaction are refused before they run. On MySQL only reads, DML, savepoints and temporary tables are allowed. | `sendproof-sqlx/tests/servers.rs::a_named_statement_that_ends_the_transaction_is_refused`; `tests/preview.rs::a_named_commit_is_refused_before_it_runs` |
| RS-2 | High | Rust on SQLite | `adapters/rust/sendproof-sqlx/src/sqlite/mod.rs:113` | A raw `COMMIT`, and any raw write after it, persisted. | A commit hook turns every commit into a rollback while the Preview runs. | `tests/preview.rs::a_raw_commit_inside_a_preview_never_persists_anything` |
| RS-3 | High | Rust on PostgreSQL | `adapters/rust/sendproof-sqlx/src/postgres/mod.rs:80` | A raw `COMMIT` persisted. | A deferred constraint trigger on a temporary table fails any commit. | `tests/servers.rs::ending_the_transaction_inside_a_preview_is_unconfirmed` |

### Secrets in change snapshots, SQL capture and logs

Workbench users see change snapshots and captured logs, and in hosted development setups those users are often not database administrators. Secret-named columns are now always `[REDACTED]` in `key`, `before` and `after`, in every environment. The rule is the same whole-word match the SQL parameter redaction uses. Logs that print bound values are dropped or redacted.

| ID | Sev | Binding | Location | Issue | Fix | Test |
| --- | --- | --- | --- | --- | --- | --- |
| NET-2 | High | .NET EF Core | `adapters/dotnet/Sendproof.EntityFrameworkCore/EntityFrameworkChangeCapture.cs:119` | Change snapshots carried `PasswordHash`, `ApiKey` and similar properties in plain text. The Treasury example's `DemoUser.PasswordHash` was one of them. | Properties whose name or column name looks secret are redacted in key, before and after. | `tests/Sendproof.EntityFrameworkCore.Tests/PreviewProviderTests.cs::ChangeSnapshotsRedactSecretNamedColumnsInEveryEnvironment` |
| NODE-5 | Medium | Node core (SQLite, Drizzle) | `adapters/node/core/src/capture.ts:121`, `secrets.ts:21` | The secret-word list was missing `pwd`, `passwd`, `hash`, `salt` and the qualified `…key` names. There was no rule to hide every value of a statement that names a secret column. | Ported the reference whole-word rule and the statement-level rule. | `core-protocol.test.mjs` "secret names…", "SQL values are hidden…"; `sqlite.test.mts` "SQL capture redacts…" |
| NODE-6 | Medium | Node (all four ORMs) | `adapters/node/core/src/capture.ts:84` | Change snapshots exposed secret columns and secret primary keys. | Redacted in core, which every change path goes through. | `core-protocol.test.mjs` "change snapshots never carry…" |
| PY-4 | Medium | Python (all) | `adapters/python/core/src/sendproof_core/workbench.py:64,174` | Change snapshots exposed `password_hash`, `*_token` and secret primary keys. | Redacted in key, before and after. | `test_core.py::test_change_snapshots_*`; `test_fastapi_security.py::test_secret_columns_*` |
| PY-5 | Medium | Django | `adapters/python/core/src/sendproof_core/redaction.py:20,31` | The database session backend's rows and SQL showed `session_key` and `session_data`. | `session` followed by `key`, `data`, `id` or `token` now counts as secret. | `test_django_security.py::test_database_session_*` |
| PY-6 | Medium | Python (all) | `adapters/python/core/src/sendproof_core/capture.py:287,291` | SQLAlchemy `echo`, Django's query log and the text of `StatementError` put bound values into captured logs. | Those loggers' records are dropped, and parameters are stripped from exception text. | `test_core.py::test_sql_echo_*` |
| GO-3 | High | Go (all) | `adapters/go/sendproof/capture.go:146` | Change snapshots showed secret columns, including a secret primary key. | Redacted with the SQL parameter rule. | `sendproof_test.go::TestSecretColumnsAndLogAttributesAreRedacted`; `examples/tests/dbsql_test.go::TestSecretColumnsAndSessionsAreRedacted` |
| GO-9 | Low | Go (all) | `adapters/go/sendproof/protocol.go:177` | Session IDs on a sessions table could appear as SQL parameter values. | `session` and `sessions` are secret words. | GO-3 dbsql test |
| GO-10 | Low | Go (all) | `adapters/go/sendproof/slog.go:93` | slog attributes such as `password` were captured verbatim. | Redacted. | GO-3 sendproof test |
| JVM-1 | High | Spring, Ktor | `adapters/java/sendproof-core/.../CaptureLimits.java:110,136`, `SqlRedaction.java:31` | JPA and JDBC change snapshots showed secret columns. Plurals (`api_tokens`) and Spring Session's `SESSION_PRIMARY_ID` were not treated as secret. | Secret columns are redacted, and a secret-named table hides every value except its key. Plurals and session IDs are covered, so Spring Session JDBC statements are fully redacted. | `SecurityRegressionTest::secretColumnsAreRedactedInEveryPartOfAChange`, `::springSessionJdbcStatementsNeverShowTheSessionId`, `::aSecretNamedPrimaryKeyIsRedactedInTheKey` |
| JVM-9 | Low | Spring | `adapters/java/sendproof-logback/.../LogbackCaptureAppender.java:30` | Spring's `StatementCreatorUtils` TRACE log printed bound values, and log properties were built without a cap. | That logger is excluded, and properties are capped early. | covered by the JVM-1 tests |
| PHP-1 | Medium | Laravel | `adapters/php/laravel/src/Capture/CaptureListeners.php:70,121` | With the default `database` session driver, SQL capture showed the session ID and payload, including the CSRF token. | Every value of statements on the session table is hidden, and on the cache table when sessions live in the database cache. | `adapters/php/laravel/tests/SecurityTest.php::testSessionTableStatementsNeverExposeTheSessionId` |
| PHP-8 | Low | Laravel, Symfony | `adapters/php/laravel/src/Eloquent/ChangeCollector.php:73`, `adapters/php/symfony/src/Doctrine/OrmChangeCollector.php:130` | A secret-named primary key was not redacted. | Redacted. | both `SecurityTest::testASecretPrimaryKeyIsRedactedInChangeSnapshots` |
| RB-1 | High | Rails | `adapters/ruby/sendproof-activerecord/lib/sendproof/active_record/tracking.rb:46,55` | Change snapshots had no redaction, so `password_hash`, `password_digest` and tokens appeared even where SQL values were hidden. | Secret columns and the model's `filter_attributes` are redacted. | `provider_test.rb::test_change_snapshots_redact_secret_columns_and_filter_attributes` |
| RS-4 | High | Rust (all) | `adapters/rust/sendproof-core/src/limits.rs:85`, used by `transport.rs:343,453` | Change snapshots showed secret columns. | Redacted with the SQL parameter rule, including the primary key. | `limits.rs::redacts_secret_columns_in_change_snapshots`; `tests/preview.rs::secret_columns_are_redacted_in_change_snapshots` |
| RS-6 | Medium | Rust core | `adapters/rust/sendproof-core/src/layer.rs:73,113` | Secret-named `tracing` fields were captured as-is, and every field was formatted in full before clipping. | Secret fields are redacted, and formatting stops at 4096 characters. | `layer.rs::redacts_secret_fields_and_bounds_their_values` |

### Preview dispatch, routing and authorization

A Preview must run exactly the operation that was checked, through the host's own middleware and authorization, and nothing else.

| ID | Sev | Binding | Location | Issue | Fix | Test |
| --- | --- | --- | --- | --- | --- | --- |
| PY-1 | High | FastAPI, Flask, Django | `adapters/python/fastapi/.../middleware.py:185,226`; `flask/.../middleware.py:161`, `bench.py:104`; `django/.../middleware.py:136,182-195` | The Preview skipped host middleware installed before Sendproof, so a path-based auth check saw `/sendproof/_preview/…` and let it through. A method override inside the stack could also run an unmarked view. | The Preview is re-dispatched through the whole application; Django builds the full `MIDDLEWARE` chain on a copy of the request. The route and method are re-checked at the innermost point, and a mismatch gets 409 with nothing run. | `test_*_security.py::test_path_based_*`, `*reroutes*`, `*method_override*` |
| GO-6 | Medium | Go (all) | `adapters/go/sendproof/preview.go:48,154,229` | A method-override header or a router rewrite could swap in a different marked operation. | Override headers are stripped, `?_method` gets 400, and the marker must match the checked method and target. | `TestPreviewRunsOnlyTheCheckedOperation` |
| GO-7 | Medium | Go (all) | `adapters/go/sendproof/state.go:63,118` | An unmarked handler reached through a marked path could deliver effects, and `IsPreview` reported false. | During a Preview, effects are always suppressed and `IsPreview` is true. | `TestPreviewSuppressesEffectsOutsideTheMarkedHandler` |
| JVM-3 | Medium | Spring | `adapters/java/sendproof-spring-boot/.../SendproofFilter.java:65,68,84`, `PreviewTargets.java` | The Preview ran the whole filter chain for unmarked targets, so Spring Security's login, logout and switch-user endpoints could execute. The origin check ran only after dispatch, and the preview prefix was accepted anywhere in the path. | The target handler is resolved before dispatch; anything other than a marked controller method gets 404, 405 or 409 and nothing runs. Cross-origin Previews get 403 first. The prefix must sit at the mount. | `PreviewTransportTest::aFilterLevelEndpointNeverRunsForAPreview`, `::theMethodIsCheckedAgainstTheRealMapping`, `::aPreviewSegmentDeeperInThePathIsAnOrdinaryUrl` |
| JVM-4 | Medium | Spring | `adapters/java/sendproof-spring-boot/.../SendproofAutoConfiguration.java:95` | A `sendproof.filter-order` at or after Spring Security made Security authorize the `/sendproof/_preview` path instead of the real operation. | Startup fails in that configuration. | `FilterOrderTest::anOrderAtOrAfterSpringSecurityIsRefusedAtStartup` |
| JVM-5 | Low | Spring | `adapters/java/sendproof-spring-boot/.../PreviewRequestWrapper.java:54` | An earlier filter could leave the preview URL's parsed path cached on the request. | Cached path attributes are dropped before rewriting. | covered by the JVM-3 tests |
| JVM-8 | Low | Ktor | `adapters/java/sendproof-ktor/.../Sendproof.kt:134,298`, `SendproofConfig.kt` | The environment label defaulted to "Development" in production, the origin check ran after route plugins, and the README's `{ true }` example showed SQL values in every environment. | The label follows `developmentMode`, cross-origin Previews are refused before the inner call, and the README uses `{ developmentMode }`. | `SendproofPluginTest::aCrossOriginPreviewIsRefusedBeforeAnyRoutePluginRuns`, `::theEnvironmentLabelIsNotDevelopmentOutsideDevelopmentMode` |
| PHP-2 | Medium | Laravel | `adapters/php/laravel/src/SendproofServiceProvider.php:79`, `src/Http/AuthorizeWorkbench.php` | An `authorizeUsing()` closure did not protect the UI or discovery routes. | New middleware on every `/sendproof` route applies both the gate ability and the closure. | `SecurityTest::testAnAuthorizeUsingClosureGatesEveryWorkbenchRoute` |
| PHP-6 | Low | Symfony | `adapters/php/symfony/src/Http/ExecutionListener.php:47` | An observed Send by a user not admitted to the workbench had its real response replaced by a 403. | The Send runs untouched and records no trace. | `SecurityTest::testAnObservedSendByAnUnauthorizedUserRunsUntouchedWithoutATrace` |
| RS-5 | Medium | Axum, Actix | `adapters/rust/sendproof-core/src/transport.rs:187` | `workbench_policy` did not gate Previews. | `check_preview` applies the policy: 401 for anonymous, 403 for denied. | `tests/preview.rs::the_workbench_policy_gates_previews` |
| RS-7 | Low | Rust (all) | `adapters/rust/sendproof-core/src/transport.rs:395,490` | An ungated route reached by a Preview could deliver effects. | Effects are suppressed from the start of a Preview. | `tests/preview.rs::an_ungated_handler_reached_by_a_preview_cannot_deliver_effects` |
| RS-10 | Low | Rust core | `adapters/rust/sendproof-core/src/protocol.rs:91` | `/SENDPROOF/…` and `/%73endproof/…` were accepted as preview targets. | Targets are checked decoded and case-insensitively. | `protocol.rs::validates_targets` |

### Sessions, sign-in and personas

| ID | Sev | Binding | Location | Issue | Fix | Test |
| --- | --- | --- | --- | --- | --- | --- |
| PY-2 | High | Django, FastAPI | `adapters/python/django/.../middleware.py`, `fastapi/.../middleware.py` | Session changes made during a Preview were saved and sent as `Set-Cookie` on the real response, because `request.session` and `scope["session"]` were shared with the inner request. | The inner request gets its own session and state. | FastAPI and Django `test_preview_session_changes_*` |
| NET-1 | Medium | Treasury example | `examples/TreasuryApi/Endpoints/AuthenticationEndpoints.cs:35` | Anonymous callers could list every seeded user and sign in as any of them, including the admin, without a password. This worked from any machine that could reach a Development server, and a cross-site page could force a browser into a seeded account (login CSRF). | A `PersonaGuard` filter lets anonymous callers switch only from loopback, and requires every caller to be same-origin. Signed-in users may still switch. | `examples/TreasuryApi/tests/TreasuryFlowTests.cs::Persona_switching_is_local_and_same_origin_for_anonymous_callers` |
| FIX-1 | Low | Rust conformance fixture | `examples/rust-conformance-common/src/auth.rs:45` | Fixture session tokens were `s<counter>-<pid>`: predictable, and often under 8 characters. | 128-bit tokens from the standard library's OS-seeded SipHash keys, without adding a dependency. | shared suite: `assertNoCredential` in `protocol.mjs` |

### Trace ownership, IDs and storage

| ID | Sev | Binding | Location | Issue | Fix | Test |
| --- | --- | --- | --- | --- | --- | --- |
| PHP-4 | Medium | Laravel, Symfony | `adapters/php/core/src/Trace/FileTraceStore.php:103,124,143` | An existing trace directory was trusted as-is (a symlink, another user's directory, world-readable). Trace files were readable by others until the `chmod`, and stale temporary files were never removed. | Symlinked or foreign directories are refused, loose modes are tightened to 0700, files are created exclusively with mode 0600, and stale `*.tmp` files are removed. | `TraceStoreTest::testTraceFilesAndTheDirectoryArePrivate`, `::testAnExistingSharedDirectoryIsTightenedBeforeUse`, `::testASymlinkedDirectoryIsRefused`, `::testStaleTemporaryFilesAreRemoved` |
| PHP-7 | Low | Symfony | `adapters/php/symfony/src/SendproofManager.php:83` | The trace owner ignored the firewall. | The firewall name is part of the owner. | `SecurityTest::testTraceOwnersAreScopedToTheFirewall` |
| NODE-9 | Low | Node core | `adapters/node/core/src/index.ts:80,225` | The trace owner had no issuer, and trace IDs were UUIDv4 (122 random bits). | Optional `issuer` added to the owner; IDs are 128-bit hex. | `core-protocol.test.mjs` "trace ids carry 128 random bits…" |
| PY-8 | Low | Python (all) | `adapters/python/core/src/sendproof_core/workbench.py:50` | The trace owner had no issuer. | Optional `Identity.issuer` is part of the owner. | `test_core.py::test_trace_owner_separates_issuers_*` |
| PY-11 | Low | Python (all) | `adapters/python/core/src/sendproof_core/trace_store.py:50` | Trace IDs were UUIDv4. | `secrets.token_hex(16)`. | `test_core.py::test_trace_ids_*` |
| GO-12 | Low | Go (all) | `adapters/go/sendproof/sendproof.go:104` | The trace owner had no issuer. | `Principal.Issuer` is part of the owner. | `TestObservedSendTraceBelongsToItsOwner` |
| JVM-6 | Low | Spring, Ktor | `adapters/java/sendproof-core/.../TraceStore.java:66` | Trace IDs were UUIDv4. | 128 bits from `SecureRandom`. | `SecurityRegressionTest::traceIdsUseAllOneHundredTwentyEightBits` |
| RB-3 | Low | Rails | `adapters/ruby/sendproof/lib/sendproof/trace_store.rb:73` | Trace IDs were UUIDv4. | `SecureRandom.hex(16)`. | `trace_store_test.rb::test_trace_ids_carry_128_random_bits` |

### Capture limits and memory bounds

| ID | Sev | Binding | Location | Issue | Fix | Test |
| --- | --- | --- | --- | --- | --- | --- |
| NODE-10 | Low | Node core | `adapters/node/core/src/capture.ts` | Log properties were unbounded and their names were not clipped. | At most 32 properties, names clipped to 256 characters and text to 4096, `{OriginalFormat}` dropped. | `core-protocol.test.mjs` "log entries keep at most 32…" |
| RB-4 | Low | Rails | `adapters/ruby/sendproof/lib/sendproof/limits.rb:78` | Effect payloads were fully serialized before the size check. | Plain data is checked against the limits before it is serialized. | `limits_test.rb::test_oversized_payloads_are_rejected_before_serialization` |
| RS-8 | Low | Rust core | `adapters/rust/sendproof-core/src/limits.rs:63` | Effect payloads were serialized in full before the 16 KiB check. | A bounded writer measures the payload first. | `capture.rs::an_oversized_effect_payload_is_dropped_before_it_is_built` |

### Discovery and configuration

| ID | Sev | Binding | Location | Issue | Fix | Test |
| --- | --- | --- | --- | --- | --- | --- |
| PHP-5 | Low | Laravel, Symfony | `adapters/php/core/src/Capabilities.php:64` and both `WorkbenchController`s | The `isLocalUrl` check was never called, so document, field-module, sign-in and OpenAPI URLs were not validated. | `Capabilities::withBase()` validates every URL, and a bad URL fails discovery. | both `SecurityTest::testDiscoveryRefusesUrlsThatLeaveTheApplication` |
| RB-2 | Low | Rails | `adapters/ruby/sendproof/lib/sendproof/configuration.rb:176` | The URL check accepted `/%2F/host`, tabs, newlines, `#` and dot segments. | Same rules as the spec. | `middleware_test.rb::test_discovery_urls_must_stay_inside_the_application` |
| PY-9 | Low | Python (all) | `adapters/python/core/src/sendproof_core/protocol.py:60` | A malformed `Origin` could match a malformed `Host`. | An unparseable origin never matches. | `test_core.py::test_malformed_origin_*` |
| PY-10 | Low | Python (all) | `adapters/python/core/src/sendproof_core/options.py:17,38` | `%2e%2e` slipped past the URL check, and the `database` label was not validated. | Values are decoded before checking, and the label must be a bare display name. | `test_core.py::test_encoded_dot_*`, `::test_database_label_*` |
| NODE-8 | Low | Node core | `adapters/node/core/src/index.ts:114` | The `database` label could carry a connection string, URL or path. | Rejected at startup. | `core-protocol.test.mjs` "the database label…" |
| GO-11 | Low | Go (all) | `adapters/go/sendproof/middleware.go:116`, `dbsql/options.go` | A database label could be a connection string. | Withheld from discovery, and rejected by `dbsql.WithDatabaseLabel`. | `TestDiscoveryWithholdsConnectionDetails`, `TestDatabaseLabelMustBeBare` |
| RS-11 | Low | Rust SQLx | `adapters/rust/sendproof-sqlx/src/provider.rs:64` | A database label that is a URL, connection string or path would be shown. | Such labels are dropped. | `provider.rs::database_labels_are_bare_names` |

### SQL that the adapters build

None of these findings could be used for injection from request data. They are hardening of the change readers that splice metadata into their own SQL.

| ID | Sev | Binding | Location | Issue | Fix | Test |
| --- | --- | --- | --- | --- | --- | --- |
| GO-13 | Low | Go on PostgreSQL (observed Send) | `adapters/go/dbsql/keyed.go:306` | A trailing `--` comment swallowed the `RETURNING` clause the adapter appends. | `RETURNING` is inserted after the last token. | `TestReturningIsAddedAfterTheLastToken` |
| JVM-7 | Low | Spring, Ktor | `adapters/java/sendproof-jdbc/.../DmlStatement.java:56` | The change reader spliced quoted or metadata identifiers into its own SQL. | Only plain identifiers are accepted; anything else is logged as SQL without a change entry. | `JdbcPreviewTest::dmlShapesAreParsedConservatively` |
| RS-9 | Low | Rust on MySQL | `adapters/rust/sendproof-sqlx/src/query.rs:281`, `mysql/mod.rs:194` | `#` comments were not understood when placeholders were rewritten, and a trailing comment could hide the `FOR UPDATE` of the key read. | `#` comments are handled, and `FOR UPDATE` is placed on its own line. | `query.rs::mysql_hash_comments_hide_placeholders_and_quotes` |

### Transport headers

| ID | Sev | Binding | Location | Issue | Fix | Test |
| --- | --- | --- | --- | --- | --- | --- |
| NET-3 | Low | .NET | `adapters/dotnet/Sendproof.AspNetCore/PreviewTransport.cs:16` | The envelope's `headers` kept `Keep-Alive`, `TE`, `Proxy-Authenticate` and `Proxy-Connection`. | Every RFC 9110 hop-by-hop header is excluded. | `tests/Sendproof.AspNetCore.Tests/PreviewHttpTests.cs::PreviewUsesRealBindingAndAuthorizationAndWaitsForRollback` |

## Rules added to the shared conformance suite

Every binding must now pass these rules in `tests/conformance/protocol.mjs`. All 24 SQLite/H2 profiles and both .NET profiles do.

| Rule | Why |
| --- | --- |
| The discovery `database` label has no `://`, `@`, path separator or password, and discovery never contains the server database URL or its password. | Discovery is public in Development. |
| A wrong password, or an anonymous persona switch, gets 401 or 403. Any cookie that response sets leaves the caller anonymous. | Rejected sign-in must not create a session. Frameworks that always set a session cookie are allowed for. |
| The caller's session cookie never appears in a Preview envelope or a trace. | Catches request-header logging and session leaks. |
| A Preview with `Origin: null` is refused. | Sandboxed frames send the opaque origin `null`. |
| Encoded traversal is refused without confirmation: `/%2Fitems`, `/x/..%2F..%2Fitems`, `/items%2F..%2F..%2Fitems`, an encoded `/%73endproof/…` and a nested `/sendproof/_preview/…`. | The target must not escape the mount, reach workbench routes or nest a second Preview. |
| Only `<mount>/sendproof/_preview` is reserved: `/x/sendproof/_preview/items` is an ordinary URL and is not previewed. | Path-base isolation. |
| An observed Send with `Sec-Fetch-Site: cross-site` records no trace. A trace read with a foreign `Origin` or `Sec-Fetch-Site: cross-site` gets 403 or 404. | CSRF and cross-site reads with the owner's cookie. |
| A trace ID is an opaque token of at least 22 characters. | Not guessable or enumerable. |
| `Prefer: trace` records no trace in the `disabled` and `no-provider` scenarios. | Observed Send is off outside the allowed environments. |

## Checked and found sound

These areas were checked in the reference and in every binding, and were either correct already or are correct after the fixes above.

- **Off by default.** Every binding serves the workbench, Preview and observed Send only in an allow-listed environment. Outside it, `/sendproof` returns 404 and `Prefer: trace` is ignored.
  - .NET, Python, Go, Node, Rust: Development only, and an unset environment means Production.
  - Laravel and Symfony: an explicit switch plus an allow-listed environment.
  - Spring: `sendproof.enabled` plus blocked `prod`/`production` profiles.
  - Ktor and Rails: an explicit opt-in.
- **Operation authorization.** A Preview dispatches in-process through the host's real router and the endpoint's own authentication, authorization, filters and binding. No binding makes a loopback HTTP request or builds a URL from `Host`, so there is no SSRF or request-smuggling path. An optional workbench policy also gates Previews and traces.
- **OIDC and remote challenges (.NET).** The challenge endpoint only challenges schemes registered with a display name. The redirect target is fixed to `<pathBase>/sendproof/`, so there is no open redirect. Rejected callbacks leave the browser anonymous (`OidcIntegrationTests`).
- **CSRF.** Previews need the non-safelisted `Prefer: tx=rollback` header, which forces a CORS preflight, and reject cross-site and cross-origin requests. Framework CSRF middleware (Django, Laravel, Symfony, Rails) still runs on the target.
- **Preview never commits by accident.** `Prefer: tx=rollback` on an ordinary URL gets 400. A Preview needs the exact single preference value. `HEAD` gets 405. Confirmation comes only after a successful rollback, and a rollback failure, panic, client abort or oversized response yields no envelope.
- **A real Send is the host's own API call.** Server-side confirmation of a write is the host's authentication, authorization and CSRF policy; Sendproof adds only `Prefer: trace`, which does not change commit behaviour. Replaying a Preview is harmless because it always rolls back. Replaying a Send is the same as replaying any API request.
- **Inner response.** Responses are buffered with a 1 MiB cap; an oversized response gets 413 with a tiny body. Inner `Set-Cookie`, `Location`, framing and hop-by-hop headers never reach the real response or the envelope, and redirects are not followed.
- **Traces.** Only the owner can read a trace, and the owner is identified by scheme, subject, issuer where available, and path base. Missing or foreign traces get 404, responses are `no-store`, IDs come from a cryptographic generator, and stores keep at most 8 traces per owner and 32 per host for 5 minutes. PHP's file store validates IDs before using them as file names.
- **Capture limits.** 500 logs, 100 effects, 200 changes, 32 properties, 64 SQL parameters, strings clipped to 4096 characters, 16 KiB payload snapshots and 128 KiB budgets, enforced under per-request state.
- **SQL that adapters build.** Metadata queries use parameters, identifiers are quoted per dialect, and savepoint names are generated, never taken from request data.

## Accepted risks

| Risk | Bindings | Reason |
| --- | --- | --- |
| A commit inside a stored procedure, a conditional SQL Server block or a MySQL `CALL` is not detected. | all server databases | Procedure bodies can't be inspected. The guard savepoint or a liveness check still withholds confirmation on most engines. |
| A raw SQLx statement on MySQL that commits makes the earlier writes permanent. It is still never confirmed. | Rust on MySQL | MySQL has no hook to veto a commit. The README tells hosts to use `conn.query` on MySQL so the named-query guard applies. |
| A handler that calls the framework's own commit (`DB::commit()`, a raw `COMMIT` on Laravel) gets 500, but its writes are already committed. | PHP, EF Core (SQLite and SQL Server throw on the later rollback) | Fails closed, as the reference allows. Never confirmed. |
| Work outside the request (background threads, `@Async`, Starlette `BackgroundTasks`, connections checked out before the Preview, a root Knex instance) is not enrolled. | JVM, Python, Node | Documented in each README. External effects need the `tryRecord*` helpers. |
| Express and Hono middleware mounted on a parent path does not run for Previews, and routes added directly to Nest's underlying Express instance can run before the 409. | Node | By design; the READMEs require auth in the operation's own handler chain. |
| Queued jobs and Messenger messages sent during a Preview are not suppressed unless recorded through the effect API. | PHP, Rails | Hosts own their dispatchers. |
| Origin checks compare against the `Host` header, so DNS rebinding against a local development server is possible. | all | The attacker's origin carries no session cookie, so it gets only anonymous access, the same as calling the app directly. Host allow-lists (for example `AllowedHosts`) are the host's control. |
| Discovery and the UI are public in Development when no workbench policy is configured. | all | Documented. Hosted environments should set a workbench policy (`RequireAuthorization`, `authorizeUsing`, `access`, and so on). |
| Any authenticated user can evict other users' traces by filling the 32-trace host limit. | all | It is a bounded memory cap, and the only effect is that a trace stops being available. |
| Spring's default trace owner has no issuer or claim type, and Rust's `TraceOwner` has no issuer. | JVM, Rust | Hosts with several identity issuers supply their own resolver. Adding the field in Rust is a breaking API change. |
| Log properties are not redacted beyond secret-named fields in Go and Rust. With Rails at `:debug`, ActiveRecord logs show bind values filtered only by `filter_attributes`. | .NET, PHP, Rails | Logs are the host's own output, shown only to the caller of that request. |
| Trace stores are per process. | Rails, Python, Node | Affects availability across workers, not security. |
| A large effect payload is marshalled before its size check. | Go | The payload is host-supplied data, not request data. |

## Verification

| Binding | Local tests | Conformance |
| --- | --- | --- |
| .NET | `dotnet build Sendproof.slnx -c Release -warnaserror` clean. `dotnet test`: EF Core 19, ASP.NET Core 30, Treasury 7 passed. | dotnet-aspnetcore 11/11, dotnet-treasury 7/7 |
| Node | `npm test`: 170 passed, 2 skipped (they need server URLs); 285/285 with PostgreSQL and MySQL | all 8 SQLite profiles 11/11; Knex, TypeORM, Drizzle and Prisma on PostgreSQL and MySQL 11/11; node-express-knex-sqlserver 11/11 |
| Python | `pytest adapters/python`: 104 passed | fastapi, django, flask, flask-sqlalchemy 11/11; flask-sqlalchemy on PostgreSQL and MySQL 11/11 |
| Go | module path tests 15/15; `scripts/test.sh` (vet and race) passed; engine tests on PostgreSQL, MySQL and SQL Server passed | all 11 Go profiles, including server databases, 11/11 |
| JVM | `gradle.sh test`: 101 passed | java-spring 11/11, kotlin-ktor 11/11 |
| PHP | `scripts/test.sh`: core 53, Laravel 28, Symfony 29 passed | php-laravel 11/11, php-symfony 11/11 |
| Ruby | `bin/test`: 69, 27, 22 and 5 runs, 0 failures | ruby-rails 11/11 |
| Rust | `cargo test --workspace`: 99 passed; `tests/servers.rs` on PostgreSQL and MySQL 23/23 | rust-axum, rust-actix 11/11; the four PostgreSQL and MySQL profiles 11/11 |

## Follow-ups

- **Shared fixture rules not yet added.** Two rules would catch this review's two most common High findings in every binding, but each needs a new route or column in every fixture:
  - A `password_hash` column whose value must be `[REDACTED]` in change snapshots.
  - A route whose handler issues a raw `COMMIT`. It must get 500 with nothing persisted.

  Each binding covers both with local tests for now.
- **Workbench UI and the Treasury persona guard.** The UI offers "seeded accounts" to anonymous users (`ui/signin.js`, `ui/seeded-menu.js`). Opened from another machine, the Treasury example now answers 403 for that list, and the UI should then hide the persona panel and point to password sign-in rather than show an error. `ui/` is owned by another change, so this needs a UI follow-up.
