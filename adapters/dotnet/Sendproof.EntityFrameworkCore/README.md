# EF Core preview coverage

Register a relational context normally with `AddDbContext<TContext>()`, then call
`AddSendproof().AddEntityFrameworkCore<TContext>()`. The provider uses the same scoped
context as the request and rolls its transaction back after the endpoint finishes.
Each successful `SaveChanges` produces an insert, update, or delete with scalar EF
property values and the generated key after saving. Repeated saves are shown separately.
The displayed database label is derived from the database name, or the SQLite file name;
paths, connection strings and credentials are not displayed. Non-relational contexts do
not advertise preview availability.

The diff covers tracked changes saved through that context. Raw SQL, `ExecuteUpdate`,
`ExecuteDelete`, other contexts/connections, database triggers, and external side effects
are not represented in the diff. The transaction cannot undo non-database effects or
guarantee that database-generated sequence values are reclaimed. Existing transactions
and non-relational providers are not supported. Application code must not commit or
replace the preview transaction. Preview is not a general sandbox.

## MySQL and MariaDB

During a Preview the command interceptor refuses, before sending, anything that would end the Preview
transaction: `COMMIT`, `ROLLBACK`, `BEGIN`, every spelling of `SET autocommit`, MySQL's
[implicitly committing statements](https://dev.mysql.com/doc/refman/8.4/en/implicit-commit.html) (DDL,
`LOCK TABLE(S)`, `ANALYZE`, `OPTIMIZE`, `FLUSH`, `RESET`, replication statements and the rest), SQL-level
`PREPARE` and `EXECUTE`, and `CALL`, because a stored procedure can commit. A command of type
`StoredProcedure` counts as a `CALL`. SQL is read as the server reads it: the body of a `/*! ... */` comment is
SQL, `#` starts a comment, `--` starts one only before whitespace, and strings are read with and without
backslash escapes.

Declare procedures that never commit by exact name:

```csharp
builder.Services.AddSendproof().WithSafeProcedures("audit_touch", "reports.refresh_totals").AddEntityFrameworkCore<AppDbContext>();
```

> **Warning:** `WithSafeProcedures` is your statement that the procedures never commit. Sendproof trusts it: a
> listed procedure that commits persists the Preview's writes. Names match exactly (case-insensitively), with no
> wildcards.

### Plain ADO.NET and Dapper

Commands sent on the context's own connection (`Database.GetDbConnection()` with Dapper, or a hand-written
`DbCommand`) skip EF Core's interceptors, so Sendproof guards the connection itself when EF Core creates it:

- **MySql.Data** (`MySql.EntityFrameworkCore`): the driver's own command hook (`CommandInterceptors` in the
  connection string, added for you) runs the same check before every command, including the driver's own `COMMIT`
  for `MySqlTransaction.Commit()`.
- **SQLite**: the connection is wrapped so its commands, transaction and `Close()` are checked the same way.
- **Other providers** (Pomelo/MySqlConnector, Npgsql, SQL Server): their EF Core providers need the driver's own
  connection type and the drivers have no command hook, so plain ADO.NET on them is not guarded. On MySQL the
  savepoint backstop below still fails the Preview, but only after the write.

A connection your application creates and passes to EF Core isn't created by EF Core, so it isn't guarded either.

### Savepoint backstop

The Preview makes savepoint `sendproof_preview` as soon as its transaction opens and rolls back to it before the
final rollback. Any commit erases every savepoint, so a missing savepoint means the Preview's writes may have
persisted: the Preview answers 500 without confirmation. (MySQL has no `@@in_transaction`, and with auto-commit
off it opens a new transaction after a commit, so a check made only at the end can't see one.) Statements naming
the savepoint are refused.

### Deadlocks and aborted transactions

A MySQL deadlock (1213) or lock wait timeout (1205), a SQL Server deadlock victim (1205), or any SQL Server error
that leaves `@@TRANCOUNT` at 0 (as under `XACT_ABORT ON`) rolls the whole Preview transaction back, so a retry would
run outside it and, with auto-commit on, commit for real. Once Sendproof sees one, it refuses every further statement
in that Preview before sending, and the Preview answers 500 without confirmation; the handler still gets the
database's original error. EF Core commands are checked through EF Core's failure event. On MySql.Data each statement
in a Preview first runs a one-round-trip probe (`SAVEPOINT sendproof_probe; RELEASE SAVEPOINT sendproof_probe`) that
fails once the transaction is gone, so a deadlock seen through plain ADO.NET is caught too. MySQL's 1205 counts
whether or not `innodb_rollback_on_timeout` is on.

Observed sends use the same tracked-change capture while the application manages its
normal transactions. The EF adapter also attaches a command interceptor to the
registered context. It records successful provider commands, their duration, typed
parameters and row counts where available. The timings include raw SQL commands even
when those commands produce no tracked row diff.

Non-secret parameter values are shown in Development by default. Configure
`.WithSqlParameterValues(false)` on the Sendproof builder to hide all SQL parameter
values. A value is redacted whenever its parameter name or statement contains
`password`, `secret`, `token`, `key`, `hash` or `salt`, regardless of the host's EF
sensitive data logging setting. When a statement refers to a sensitive name, all its
parameter values are hidden because generated placeholders may carry no column name.
Use bound parameters for sensitive values in application SQL.
