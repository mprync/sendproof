using System.Data.Common;
using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using Microsoft.Extensions.DependencyInjection;
using Sendproof.AspNetCore;
using Xunit;
using static Sendproof.EntityFrameworkCore.Tests.TransactionControlTests;

namespace Sendproof.EntityFrameworkCore.Tests;

/// <summary>
/// The start-savepoint backstop of spec/data-stores.md "Transaction-control statements from the handler" on every
/// relational provider: a commit by a route the pre-send guard can't see makes the Preview fail with 500 instead of
/// confirming. On SQL Server and PostgreSQL that route is plain ADO.NET on EF Core's own connection, which no driver hook
/// guards; on SQLite (whose connection Sendproof wraps) it is the provider's connection behind the wrapper. Server
/// databases skip when their compose service isn't running.
/// </summary>
public sealed class BackstopTests
{
    [Fact]
    public async Task Sqlite()
    {
        var path = Path.Combine(Path.GetTempPath(), "sp_backstop_" + Guid.NewGuid().ToString("N") + ".db");
        try
        {
            await ScenarioAsync(options => options.UseSqlite($"Data Source={path}"), db =>
            {
                var inner = Assert.IsType<SendproofDbConnection>(db.Database.GetDbConnection()).Inner;
                return CommitAsync(inner, SendproofDbConnection.Unwrap(db.Database.CurrentTransaction!.GetDbTransaction()));
            });
        }
        finally
        {
            Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
            File.Delete(path);
        }
    }

    [ServiceFact("postgres")]
    public async Task PostgreSql()
    {
        var name = "tb_ef_" + Guid.NewGuid().ToString("N")[..10];
        await AdminAsync(new DbContextOptionsBuilder().UseNpgsql(ServiceFactAttribute.PostgresRoot + ";Database=postgres"), $"CREATE DATABASE {name}");
        try
        {
            await ScenarioAsync(options => options.UseNpgsql($"{ServiceFactAttribute.PostgresRoot};Database={name}"), RawCommitAsync);
        }
        finally
        {
            Npgsql.NpgsqlConnection.ClearAllPools();
            await AdminAsync(new DbContextOptionsBuilder().UseNpgsql(ServiceFactAttribute.PostgresRoot + ";Database=postgres"),
                $"DROP DATABASE IF EXISTS {name} WITH (FORCE)");
        }
    }

    [ServiceFact("sqlserver")]
    public async Task SqlServer()
    {
        var name = "tb_ef_" + Guid.NewGuid().ToString("N")[..10];
        await AdminAsync(new DbContextOptionsBuilder().UseSqlServer(ServiceFactAttribute.SqlServerRoot), $"CREATE DATABASE {name}");
        try
        {
            await ScenarioAsync(options => options.UseSqlServer($"{ServiceFactAttribute.SqlServerRoot};Database={name}"), RawCommitAsync);
        }
        finally
        {
            Microsoft.Data.SqlClient.SqlConnection.ClearAllPools();
            await AdminAsync(new DbContextOptionsBuilder().UseSqlServer(ServiceFactAttribute.SqlServerRoot),
                $"ALTER DATABASE [{name}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [{name}]");
        }
    }

    /// <summary>
    /// A unique violation the handler answers with 409 leaves the PostgreSQL transaction aborted; the check (a rollback to
    /// the savepoint, which also unwinds a nested savepoint the handler left open) still succeeds, so the Preview stays
    /// confirmable.
    /// </summary>
    [ServiceFact("postgres")]
    public async Task APostgreSqlHandlerErrorAnsweredAs409KeepsThePreviewConfirmable()
    {
        var name = "tb_ef_" + Guid.NewGuid().ToString("N")[..10];
        var admin = new DbContextOptionsBuilder().UseNpgsql(ServiceFactAttribute.PostgresRoot + ";Database=postgres");
        await AdminAsync(admin, $"CREATE DATABASE {name}");
        try
        {
            var services = new ServiceCollection();
            services.AddDbContext<ExampleContext>(options => options.UseNpgsql($"{ServiceFactAttribute.PostgresRoot};Database={name}"));
            services.AddSendproof().AddEntityFrameworkCore<ExampleContext>();
            await using var root = services.BuildServiceProvider();
            await using (var setup = root.CreateAsyncScope())
            {
                var db = setup.ServiceProvider.GetRequiredService<ExampleContext>();
                await db.Database.EnsureCreatedAsync();
                db.Items.Add(new Item { Id = "taken", Name = "x" });
                await db.SaveChangesAsync();
            }

            var outcome = await PreviewAsync(root, async db =>
            {
                await db.Database.ExecuteSqlRawAsync("SAVEPOINT handler_nested");
                db.Items.Add(new Item { Id = "taken", Name = "dup" });
                // The handler catches the unique violation and answers 409; the transaction is now aborted.
                await Assert.ThrowsAsync<DbUpdateException>(() => db.SaveChangesAsync());
            });
            Assert.Null(outcome.Rollback);
            Assert.Null(outcome.Fault);
        }
        finally
        {
            Npgsql.NpgsqlConnection.ClearAllPools();
            await AdminAsync(admin, $"DROP DATABASE IF EXISTS {name} WITH (FORCE)");
        }
    }

    [Theory]
    [InlineData("RELEASE SAVEPOINT sendproof_preview")]
    [InlineData("ROLLBACK TO SAVEPOINT \"sendproof_preview\"")]
    [InlineData("SAVEPOINT sendproof_preview")]
    [InlineData("SAVE TRANSACTION sendproof_preview")]
    [InlineData("SAVE TRAN [sendproof_preview]")]
    [InlineData("ROLLBACK TRANSACTION sendproof_preview")]
    public void EveryDatabaseRefusesTheHandlerTouchingTheBackstopSavepoint(string sql)
    {
        Assert.True(SqlStatements.EndsTransaction(sql, mysql: false), sql);
        // On MySQL a double-quoted name is a string, which no savepoint statement accepts.
        if (!sql.Contains('"')) Assert.True(SqlStatements.EndsTransaction(sql, mysql: true), sql);
    }

    [Theory]
    [InlineData("SET IMPLICIT_TRANSACTIONS OFF", false)]
    [InlineData("SET IMPLICIT_TRANSACTIONS ON", true)]
    public void SqlServerImplicitTransactionsOffKeepsTheTransaction(string sql, bool refused) =>
        Assert.Equal(refused, SqlStatements.EndsTransaction(sql, mysql: false));

    [Theory]
    [InlineData("SAVE TRANSACTION nested")]
    [InlineData("ROLLBACK TRANSACTION [__EFSavePoint]")]
    [InlineData("SAVEPOINT sendproof_preview_2")]
    public void OtherSavepointsStayAllowed(string sql) => Assert.False(SqlStatements.EndsTransaction(sql, mysql: false), sql);

    /// <summary>A commit on EF Core's own connection with plain ADO.NET, which no guard sees on this provider.</summary>
    private static Task RawCommitAsync(ExampleContext db) =>
        CommitAsync(db.Database.GetDbConnection(), db.Database.CurrentTransaction!.GetDbTransaction());

    private static async Task CommitAsync(DbConnection connection, DbTransaction? transaction)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = "COMMIT";
        command.Transaction = transaction;
        await command.ExecuteNonQueryAsync();
    }

    /// <summary>
    /// An ordinary Preview stays confirmable; one whose transaction is committed around the guard, then written to again,
    /// fails. The commit really happened (its row persists), so confirming would have been a lie.
    /// </summary>
    private static async Task ScenarioAsync(Action<DbContextOptionsBuilder> configure, Func<ExampleContext, Task> commitAround)
    {
        var services = new ServiceCollection();
        services.AddDbContext<ExampleContext>(configure);
        services.AddSendproof().AddEntityFrameworkCore<ExampleContext>();
        await using var root = services.BuildServiceProvider();
        await using (var setup = root.CreateAsyncScope())
        {
            await setup.ServiceProvider.GetRequiredService<ExampleContext>().Database.EnsureCreatedAsync();
        }

        var ordinary = await PreviewAsync(root, async db =>
        {
            db.Items.Add(new Item { Id = "kept", Name = "x" });
            await db.SaveChangesAsync();
        });
        Assert.Null(ordinary.Rollback);
        Assert.Null(ordinary.Fault);

        var escaped = await PreviewAsync(root, async db =>
        {
            db.Items.Add(new Item { Id = "escaped", Name = "x" });
            await db.SaveChangesAsync();
            await commitAround(db);
            // Whatever transaction follows; the write may fail or land, but the Preview must not be confirmed.
            try
            {
                await db.Database.ExecuteSqlRawAsync("INSERT INTO Items (Id, Name) VALUES ('after', 'x')");
            }
            catch (Exception)
            {
                // A provider may refuse to use a completed transaction.
            }
        });
        Assert.IsType<PreviewTransactionEndedException>(escaped.Rollback);

        await using var verify = root.CreateAsyncScope();
        var items = verify.ServiceProvider.GetRequiredService<ExampleContext>().Items;
        Assert.Equal(0, await items.CountAsync(item => item.Id == "kept"));
        Assert.Equal(1, await items.CountAsync(item => item.Id == "escaped"));
    }

    private static async Task<(Exception? Rollback, Exception? Fault)> PreviewAsync(IServiceProvider root, Func<ExampleContext, Task> handler)
    {
        await using var scope = root.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ExampleContext>();
        var recorder = scope.ServiceProvider.GetRequiredService<SendproofPreview>();
        recorder.MarkPreview();
        using var current = root.GetRequiredService<CaptureContext>().Enter(recorder);
        await using var session = await scope.ServiceProvider.GetRequiredService<IPreviewProvider>()
            .BeginAsync(new DefaultHttpContext { RequestServices = scope.ServiceProvider }, CancellationToken.None);
        await handler(db);
        try
        {
            await session.RollbackAsync(CancellationToken.None);
            return (null, recorder.Fault);
        }
        catch (Exception failure)
        {
            return (failure, recorder.Fault);
        }
    }

    private static async Task AdminAsync(DbContextOptionsBuilder options, string sql)
    {
        await using var admin = new DbContext(options.Options);
        await admin.Database.ExecuteSqlRawAsync(sql);
    }
}
