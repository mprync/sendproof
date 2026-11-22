using System.Data;
using System.Data.Common;
using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using Microsoft.Extensions.DependencyInjection;
using Sendproof.AspNetCore;
using Sendproof.EntityFrameworkCore;
using Xunit;
using static Sendproof.EntityFrameworkCore.Tests.TransactionControlTests;

namespace Sendproof.EntityFrameworkCore.Tests;

/// <summary>
/// The MySQL transaction escapes of spec/data-stores.md "Transaction-control statements from the handler": the rest of
/// the refused list (CALL with its exact-name opt-out, PREPARE/EXECUTE, the backstop savepoint) with MySQL's own lexical
/// rules, and the savepoint backstop against the compose MySQL service with auto-commit off.
/// </summary>
public sealed class MySqlEscapeTests
{
    private static readonly IReadOnlySet<string> Safe = SqlStatements.SafeProcedures(["audit_touch", "reports.refresh_totals"]);

    [Theory]
    [InlineData("CALL sendproof_commit_probe()")]
    [InlineData("call sendproof_commit_probe")]
    [InlineData("CALL other.audit_touch()")]
    [InlineData("CALL audit_touch_all()")]
    [InlineData("CALL `sendproof_commit_probe`()")]
    [InlineData("CALL audit_touch(); COMMIT")]
    [InlineData("/*! CALL sendproof_commit_probe() */")]
    [InlineData("PREPARE s FROM 'COMMIT'")]
    [InlineData("EXECUTE s")]
    [InlineData("EXECUTE IMMEDIATE 'COMMIT'")]
    [InlineData("execute immediate @sql")]
    [InlineData("CHECK TABLE t")]
    [InlineData("IMPORT TABLE FROM 'f'")]
    [InlineData("CHANGE MASTER TO MASTER_HOST='h'")]
    [InlineData("START SLAVE")]
    [InlineData("STOP REPLICA")]
    [InlineData("LOCK TABLE t WRITE")]
    [InlineData("SET @a = 1, @b = 2, autocommit = 1")]
    [InlineData("SET sql_mode = '', @@local.autocommit = 1")]
    [InlineData("RELEASE SAVEPOINT sendproof_preview")]
    [InlineData("ROLLBACK TO `SENDPROOF_PREVIEW`")]
    [InlineData("ROLLBACK WORK TO SAVEPOINT sendproof_preview")]
    [InlineData("SAVEPOINT sendproof_preview")]
    // Lexical rules: a backslash escapes a quote (also in double-quoted strings), unless NO_BACKSLASH_ESCAPES is on;
    // # starts a comment; -- starts one only before whitespace.
    [InlineData("SELECT \"a\\\"\"; COMMIT")]
    [InlineData("SELECT 'a\\''; COMMIT")]
    [InlineData("SELECT 'a\\'; COMMIT; -- '")]
    [InlineData("SELECT 1 # it's\n; COMMIT")]
    [InlineData("SELECT 1--1; COMMIT")]
    public void MySqlRefuses(string sql) => Assert.True(SqlStatements.EndsTransaction(sql, mysql: true, Safe), sql);

    [Theory]
    [InlineData("CALL audit_touch()")]
    [InlineData("call AUDIT_TOUCH(1, 2)")]
    [InlineData("CALL `reports`.`refresh_totals`()")]
    [InlineData("SET @autocommit = 1")]
    [InlineData("SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED")]
    [InlineData("SAVEPOINT sendproof_preview_2")]
    [InlineData("ROLLBACK TO SAVEPOINT s1")]
    [InlineData("SELECT 'it''s; COMMIT'")]
    [InlineData("SELECT 1 # ; COMMIT")]
    [InlineData("SELECT 1 -- ; COMMIT")]
    [InlineData("UPDATE t SET n = n - -1")]
    [InlineData("CREATE TEMPORARY TABLE t (a int)")]
    public void MySqlAllows(string sql) => Assert.False(SqlStatements.EndsTransaction(sql, mysql: true, Safe), sql);

    [Theory]
    // PostgreSQL's standard strings have no backslash escapes: the string ends at the backslash-quote.
    [InlineData("SELECT 'a\\'; COMMIT; --'")]
    [InlineData("SET x = 1, autocommit = 1")]
    public void OtherDatabasesReadStringsBothWays(string sql) => Assert.True(SqlStatements.EndsTransaction(sql, mysql: false), sql);

    [Fact]
    public void OtherDatabasesMayCallProcedures() => Assert.False(SqlStatements.EndsTransaction("CALL refresh_totals()", mysql: false));

    [Fact]
    public void SafeProceduresMatchAsMySqlNamesRoutines()
    {
        // Case-insensitive, backticks stripped, and a schema-qualified call matches only a declaration with that schema.
        var safe = SqlStatements.SafeProcedures(["audit"]);
        Assert.False(SqlStatements.EndsTransaction("CALL AUDIT()", mysql: true, safe));
        Assert.False(SqlStatements.EndsTransaction("CALL `Audit`()", mysql: true, safe));
        Assert.True(SqlStatements.EndsTransaction("CALL other.audit()", mysql: true, safe));
        Assert.True(SqlStatements.EndsTransaction("CALL `other`.`audit`()", mysql: true, safe));
        Assert.False(SqlStatements.EndsTransaction(CommandType.StoredProcedure, "AUDIT", true, safe));
        var qualified = SqlStatements.SafeProcedures(["`Reports`.audit"]);
        Assert.False(SqlStatements.EndsTransaction("CALL reports.AUDIT()", mysql: true, qualified));
        Assert.True(SqlStatements.EndsTransaction("CALL other.audit()", mysql: true, qualified));
    }

    [Theory]
    [InlineData("audit_*")]
    [InlineData("audit%")]
    [InlineData(" ")]
    [InlineData("a?b")]
    public void SafeProceduresTakeExactNamesOnly(string name) =>
        Assert.Throws<ArgumentException>(() => SqlStatements.SafeProcedures([name]));

    [Fact]
    public void ACommandOfTypeStoredProcedureIsACall()
    {
        Assert.True(SqlStatements.EndsTransaction(CommandType.StoredProcedure, "sendproof_commit_probe", true, Safe));
        Assert.False(SqlStatements.EndsTransaction(CommandType.StoredProcedure, "audit_touch", true, Safe));
        Assert.False(SqlStatements.EndsTransaction(CommandType.StoredProcedure, "refresh", false, Safe));
    }

    // ---- Against the compose MySQL service ----

    private sealed record Run(ServiceProvider Services, string Database) : IAsyncDisposable
    {
        public async ValueTask DisposeAsync()
        {
            await Services.DisposeAsync();
            await using var admin = new DbContext(new DbContextOptionsBuilder().UseMySQL(ServiceFactAttribute.MySqlRoot).Options);
            await admin.RunAsync($"DROP DATABASE IF EXISTS {Database}");
        }
    }

    private static async Task<Run> StartAsync(Action<SendproofBuilder>? configure = null)
    {
        var root = ServiceFactAttribute.MySqlRoot;
        var name = "tb_ef_" + Guid.NewGuid().ToString("N")[..10];
        await using (var admin = new DbContext(new DbContextOptionsBuilder().UseMySQL(root).Options))
        {
            await admin.RunAsync($"CREATE DATABASE {name}");
        }

        var services = new ServiceCollection();
        services.AddDbContext<ExampleContext>(options => options.UseMySQL($"{root};database={name};Pooling=true"));
        var sendproof = services.AddSendproof();
        configure?.Invoke(sendproof);
        sendproof.AddEntityFrameworkCore<ExampleContext>();
        var provider = services.BuildServiceProvider();
        await using (var setup = provider.CreateAsyncScope())
        {
            var db = setup.ServiceProvider.GetRequiredService<ExampleContext>();
            await db.Database.EnsureCreatedAsync();
            await db.Database.ExecuteSqlRawAsync("CREATE PROCEDURE sendproof_commit_probe() BEGIN COMMIT; END");
            await db.Database.ExecuteSqlRawAsync("CREATE PROCEDURE audit_touch() BEGIN SELECT 1; END");
        }

        return new Run(provider, name);
    }

    /// <summary>Runs <paramref name="handler"/> as a Preview's handler; returns the rollback's failure and the recorder's fault.</summary>
    private static async Task<(Exception? Rollback, Exception? Fault)> PreviewAsync(Run run, Func<ExampleContext, Task> handler,
        bool autocommitOff = false)
    {
        await using var scope = run.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ExampleContext>();
        if (autocommitOff)
        {
            // Some drivers and hosts run every session with auto-commit off; MySQL then opens a new transaction
            // implicitly after any commit.
            await db.Database.OpenConnectionAsync();
            await Raw(db, "SET autocommit = 0");
        }

        var recorder = scope.ServiceProvider.GetRequiredService<SendproofPreview>();
        recorder.MarkPreview();
        using var current = run.Services.GetRequiredService<CaptureContext>().Enter(recorder);
        await using var session = await scope.ServiceProvider.GetRequiredService<IPreviewProvider>()
            .BeginAsync(new DefaultHttpContext { RequestServices = scope.ServiceProvider }, CancellationToken.None);
        Exception? handlerFailure = null;
        try
        {
            await handler(db);
        }
        catch (Exception failure)
        {
            // An assertion in the handler: reported after the rollback, so the cleanup can't hide it.
            handlerFailure = failure;
        }

        Exception? rollbackFailure = null;
        try
        {
            await session.RollbackAsync(CancellationToken.None);
        }
        catch (Exception failure)
        {
            rollbackFailure = failure;
        }

        if (handlerFailure is not null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Throw(handlerFailure);
        return (rollbackFailure, recorder.Fault);
    }

    /// <summary>Runs SQL on the context's connection with plain ADO.NET, which EF Core's interceptors never see.</summary>
    private static async Task Raw(ExampleContext db, string sql)
    {
        await using var command = db.Database.GetDbConnection().CreateCommand();
        command.CommandText = sql;
        command.Transaction = db.Database.CurrentTransaction?.GetDbTransaction();
        await command.ExecuteNonQueryAsync();
    }

    /// <summary>
    /// Runs SQL past every Sendproof guard, standing in for a route none of them sees (a connection the application
    /// created itself, a trigger, another driver).
    /// </summary>
    private static Task RawPastTheGuard(ExampleContext db, string sql) => OwnSql.RunAsync(() => Raw(db, sql));

    private static async Task<int> CountAsync(Run run, string id)
    {
        await using var scope = run.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<ExampleContext>().Items.CountAsync(item => item.Id == id);
    }

    [ServiceFact("mysql")]
    public async Task ACallIsRefusedBeforeSendingAndADeclaredProcedureRuns()
    {
        await using var run = await StartAsync(sendproof => sendproof.WithSafeProcedures("audit_touch"));
        var refused = await PreviewAsync(run, async db =>
        {
            db.Items.Add(new Item { Id = "called", Name = "x" });
            await db.SaveChangesAsync();
            await Assert.ThrowsAsync<PreviewTransactionControlException>(() => db.Database.ExecuteSqlRawAsync("CALL sendproof_commit_probe()"));
        });
        Assert.NotNull(refused.Fault);
        Assert.Equal(0, await CountAsync(run, "called"));

        var declared = await PreviewAsync(run, async db =>
        {
            db.Items.Add(new Item { Id = "declared", Name = "x" });
            await db.SaveChangesAsync();
            await db.Database.ExecuteSqlRawAsync("CALL audit_touch()");
        });
        Assert.Null(declared.Fault);
        Assert.Null(declared.Rollback);
        Assert.Equal(0, await CountAsync(run, "declared"));
    }

    [ServiceFact("mysql")]
    public async Task PlainAdoNetOnTheContextsConnectionIsRefusedBeforeSending()
    {
        await using var run = await StartAsync();
        foreach (var sql in new[] { "COMMIT", "CALL sendproof_commit_probe()", "CREATE TABLE sendproof_escape_raw (n INT)",
                     "RELEASE SAVEPOINT sendproof_preview" })
        {
            var id = "raw-" + sql.Length;
            var outcome = await PreviewAsync(run, async db =>
            {
                db.Items.Add(new Item { Id = id, Name = "x" });
                await db.SaveChangesAsync();
                // The way Dapper or hand-written ADO.NET reaches the database: a command on EF Core's own connection,
                // which EF Core's interceptors never see.
                await Assert.ThrowsAsync<PreviewTransactionControlException>(() => Raw(db, sql));
            });
            Assert.NotNull(outcome.Fault);
            Assert.Equal(0, await CountAsync(run, id));
        }

        var transactional = await PreviewAsync(run, async db =>
        {
            db.Items.Add(new Item { Id = "raw-transaction", Name = "x" });
            await db.SaveChangesAsync();
            // The driver's own COMMIT for MySqlTransaction.Commit() meets the same hook.
            Assert.Throws<PreviewTransactionControlException>(() => db.Database.CurrentTransaction!.GetDbTransaction().Commit());
            // MySql.Data refuses a nested transaction itself; either way nothing is sent.
            Assert.ThrowsAny<Exception>(() => db.Database.GetDbConnection().BeginTransaction());
        });
        Assert.NotNull(transactional.Fault);
        Assert.Equal(0, await CountAsync(run, "raw-transaction"));

        // Ordinary raw reads and writes still run inside the Preview transaction.
        var ordinary = await PreviewAsync(run, async db =>
        {
            await Raw(db, "INSERT INTO Items (Id, Name) VALUES ('raw-ok', 'x')");
            await using var command = db.Database.GetDbConnection().CreateCommand();
            command.CommandText = "SELECT COUNT(*) FROM Items WHERE Id = 'raw-ok'";
            command.Transaction = db.Database.CurrentTransaction!.GetDbTransaction();
            Assert.Equal(1L, Convert.ToInt64(await command.ExecuteScalarAsync()));
        });
        Assert.Null(ordinary.Fault);
        Assert.Null(ordinary.Rollback);
        Assert.Equal(0, await CountAsync(run, "raw-ok"));
    }

    [Fact]
    public async Task PlainAdoNetOnASqliteContextsConnectionIsRefusedBeforeSending()
    {
        var path = Path.Combine(Path.GetTempPath(), "sp_raw_" + Guid.NewGuid().ToString("N") + ".db");
        try
        {
            var services = new ServiceCollection();
            services.AddDbContext<ExampleContext>(options => options.UseSqlite($"Data Source={path}"));
            services.AddSendproof().AddEntityFrameworkCore<ExampleContext>();
            await using var root = services.BuildServiceProvider();
            await using (var setup = root.CreateAsyncScope())
            {
                await setup.ServiceProvider.GetRequiredService<ExampleContext>().Database.EnsureCreatedAsync();
            }

            await using (var scope = root.CreateAsyncScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<ExampleContext>();
                var recorder = scope.ServiceProvider.GetRequiredService<SendproofPreview>();
                recorder.MarkPreview();
                using var current = root.GetRequiredService<CaptureContext>().Enter(recorder);
                await using var session = await scope.ServiceProvider.GetRequiredService<IPreviewProvider>()
                    .BeginAsync(new DefaultHttpContext { RequestServices = scope.ServiceProvider }, CancellationToken.None);
                db.Items.Add(new Item { Id = "sqlite-raw", Name = "x" });
                await db.SaveChangesAsync();
                await Assert.ThrowsAsync<PreviewTransactionControlException>(() => Raw(db, "COMMIT"));
                Assert.NotNull(recorder.Fault);
                await session.RollbackAsync(CancellationToken.None);
            }

            await using var verify = root.CreateAsyncScope();
            Assert.Empty(await verify.ServiceProvider.GetRequiredService<ExampleContext>().Items.ToListAsync());
        }
        finally
        {
            Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
            File.Delete(path);
        }
    }

    [ServiceFact("mysql")]
    public async Task ACommitTheGuardsMissFailsThePreviewWithAutoCommitOff()
    {
        await using var run = await StartAsync();
        var outcome = await PreviewAsync(run, async db =>
        {
            db.Items.Add(new Item { Id = "escaped", Name = "x" });
            await db.SaveChangesAsync();
            // Past every Sendproof wrapper: the provider's own connection, which only Sendproof holds.
            await RawPastTheGuard(db, "COMMIT");
            // With auto-commit off MySQL opens a new transaction implicitly, so a check made only at the end (a fresh
            // SAVEPOINT then RELEASE) would succeed and wrongly report the Preview transaction as still open.
            db.Items.Add(new Item { Id = "after", Name = "x" });
            await db.SaveChangesAsync();
            await Raw(db, "SAVEPOINT end_only_probe");
            await Raw(db, "RELEASE SAVEPOINT end_only_probe");
        }, autocommitOff: true);
        var failure = Assert.IsType<PreviewTransactionEndedException>(outcome.Rollback);
        Assert.Contains("committed", failure.Message);
        Assert.Equal(0, await CountAsync(run, "after"));
    }

    [ServiceFact("mysql")]
    public async Task APreviewThatCommitsNothingStaysConfirmable()
    {
        await using var run = await StartAsync();
        foreach (var autocommitOff in new[] { false, true })
        {
            var outcome = await PreviewAsync(run, async db =>
            {
                db.Items.Add(new Item { Id = "kept-" + autocommitOff, Name = "x" });
                await db.SaveChangesAsync();
                await db.Database.ExecuteSqlRawAsync("SAVEPOINT nested");
                await db.Database.ExecuteSqlRawAsync("ROLLBACK TO SAVEPOINT nested");
            }, autocommitOff);
            Assert.Null(outcome.Rollback);
            Assert.Null(outcome.Fault);
            Assert.Equal(0, await CountAsync(run, "kept-" + autocommitOff));
        }
    }

    /// <summary>
    /// A deadlock rolls the whole Preview transaction back, so with auto-commit on a retry would commit for real. The
    /// Preview is made the deadlock victim (the other transaction has written more rows, and InnoDB rolls back the
    /// smaller one), then the handler retries the write through EF Core and through plain ADO.NET.
    /// </summary>
    [ServiceFact("mysql")]
    public async Task AfterADeadlockEveryFurtherStatementIsRefusedAndARetryNeverCommits()
    {
        foreach (var throughEf in new[] { true, false })
        {
            await using var run = await StartAsync();
            await using (var seed = run.Services.CreateAsyncScope())
            {
                var db = seed.ServiceProvider.GetRequiredService<ExampleContext>();
                db.Items.AddRange(new Item { Id = "a", Name = "a" }, new Item { Id = "b", Name = "b" });
                await db.SaveChangesAsync();
            }

            await using var other = new MySql.Data.MySqlClient.MySqlConnection($"{ServiceFactAttribute.MySqlRoot};database={run.Database}");
            await other.OpenAsync();
            await using var otherTransaction = await other.BeginTransactionAsync();
            async Task OtherAsync(string sql)
            {
                await using var command = other.CreateCommand();
                command.CommandText = sql;
                command.Transaction = otherTransaction;
                await command.ExecuteNonQueryAsync();
            }

            await OtherAsync("INSERT INTO Items (Id, Name) VALUES ('w1', 'w'), ('w2', 'w'), ('w3', 'w'), ('w4', 'w')");
            await OtherAsync("UPDATE Items SET Name = 'other' WHERE Id = 'b'");

            Exception? original = null;
            var outcome = await PreviewAsync(run, async db =>
            {
                Task Run(string sql) => throughEf ? db.Database.ExecuteSqlRawAsync(sql) : Raw(db, sql);
                await Run("UPDATE Items SET Name = 'preview' WHERE Id = 'a'");
                var blocked = OtherAsync("UPDATE Items SET Name = 'other' WHERE Id = 'a'");
                await Task.Delay(300);
                original = await Record.ExceptionAsync(() => Run("UPDATE Items SET Name = 'preview' WHERE Id = 'b'"));
                await blocked;
                // The handler's retry, as an ORM's retry policy would make it: refused before sending.
                var retry = await Record.ExceptionAsync(() => Run("INSERT INTO Items (Id, Name) VALUES ('retry', 'x')"));
                Assert.True(retry is PreviewTransactionControlException, $"through EF Core: {throughEf}; {retry}");
                db.Items.Add(new Item { Id = "retry-ef", Name = "x" });
                await Assert.ThrowsAnyAsync<Exception>(() => db.SaveChangesAsync());
            });
            await otherTransaction.RollbackAsync();

            // The handler saw the database's own deadlock error, and the Preview failed.
            Assert.Contains("Deadlock", Assert.IsAssignableFrom<DbException>(original is DbException ? original : original?.InnerException).Message,
                StringComparison.OrdinalIgnoreCase);
            Assert.NotNull(outcome.Fault);
            Assert.Equal(0, await CountAsync(run, "retry"));
            Assert.Equal(0, await CountAsync(run, "retry-ef"));
        }
    }

    [ServiceFact("mysql")]
    public async Task TheHandlerCannotTouchTheBackstopSavepoint()
    {
        await using var run = await StartAsync();
        var outcome = await PreviewAsync(run, async db =>
            await Assert.ThrowsAsync<PreviewTransactionControlException>(() =>
                db.Database.ExecuteSqlRawAsync("RELEASE SAVEPOINT sendproof_preview")));
        Assert.NotNull(outcome.Fault);
    }
}
