# sendproof-jpa

JPA/Hibernate and Spring-managed JDBC data integration for `sendproof-spring-boot`. It is auto-configured when `sendproof.enabled=true` (opt out with `sendproof.jpa.enabled=false`).

## How enrollment works

`JpaPreviewProvider` opens an **outer Spring transaction** with the application's `PlatformTransactionManager` immediately before the handler. Everything that uses Spring-managed transactions joins it: `@Transactional` services, Spring Data repositories, an injected `EntityManager`, and `JdbcTemplate`. After the handler the persistence context is flushed (so SQL runs and constraints are checked), then the transaction is **always rolled back**. The result is only confirmed if the rollback succeeded.

Because every operation must be fully enrolled, these are refused rather than allowed to persist:

- a nested `@Transactional(propagation = REQUIRES_NEW)` call, which would commit independently;
- data-changing SQL on a connection that is not in a transaction (for example `Propagation.NOT_SUPPORTED`);
- SQL and JDBC calls that end the transaction (`COMMIT`, `ROLLBACK`, DDL, `Connection.commit()`).

On MySQL and MariaDB the preview also refuses `CALL`, the rest of MySQL's implicit-commit list and `PREPARE`/`EXECUTE`,
and keeps a savepoint backstop, exactly as [sendproof-jdbc](../sendproof-jdbc/README.md#mysql-and-mariadb) describes.
The backstop needs the transaction manager's `DataSource` (`JpaTransactionManager` or `DataSourceTransactionManager`).
Declare procedures that never commit with `sendproof.sql.safe-procedures` (or `JpaPreviewProvider.safeProcedures(...)`):

```properties
sendproof.sql.safe-procedures=audit_touch,reports.refresh_totals
```

> **Warning:** the list is your statement that the procedures never commit. Sendproof trusts it: a listed procedure that
> commits persists the preview's writes. Names match exactly (case-insensitively), with no wildcards.

A `@Transactional` method boundary flushes on return during a preview, so a duplicate key or other constraint violation surfaces where a real commit would raise it and your `@ControllerAdvice` can answer. Repository calls made directly from a controller flush at the end of the preview instead; a violation there leaves the preview unconfirmed (500).

## What is captured

- **Changes** (entity writes): Hibernate post-insert/update/delete events give `insert`/`update`/`delete` with the row key and before/after values, keyed by physical column name as the naming strategy resolved it (`passwordHash` mapped to `password_hash` is reported as `password_hash`; an embeddable keeps its property name). A value is `[REDACTED]` when its column name or its property name is secret. Associations appear as the referenced key; collections are skipped. Bulk JPQL, native statements and `JdbcTemplate` writes are logged as SQL but are not row changes.
- **SQL**: every statement through the application's `DataSource`, with duration, rows affected and bound values. The `DataSource` bean is wrapped (with [datasource-proxy](https://github.com/jdbc-observations/datasource-proxy)) so capture also covers plain JDBC. Parameter names are inferred from the SQL. Values are shown only in development-like environments, and secret-named parameters or statements are always `[REDACTED]`.
- **Database label**: a short, non-secret label (for example `In-memory H2` or the catalog name), never a URL.

## Replacing or decorating the provider

`JpaPreviewProvider` is registered unless you define your own bean of that type. To wrap it (for example to inject faults in tests), define another `PreviewProvider` and mark it `@Primary`; exactly one provider (or one primary) is used.
