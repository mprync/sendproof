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

Plain ADO.NET commands on the context's connection (`GetDbConnection().CreateCommand()`) don't pass EF Core's
interceptors, so they can't be refused. As a backstop the Preview makes savepoint `sendproof_preview` as soon as
its transaction opens and rolls back to it before the final rollback. Any commit erases every savepoint, so a
missing savepoint means the Preview's writes may have persisted: the Preview answers 500 without confirmation.
(MySQL has no `@@in_transaction`, and with auto-commit off it opens a new transaction after a commit, so a check
made only at the end can't see one.) Statements naming the savepoint are refused.

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
