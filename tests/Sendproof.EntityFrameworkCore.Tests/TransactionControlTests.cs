using System.Net.Sockets;
using Microsoft.AspNetCore.Http;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Sendproof.AspNetCore;
using Sendproof.EntityFrameworkCore;
using Xunit;

namespace Sendproof.EntityFrameworkCore.Tests;

/// <summary>
/// The raw-commit rule (spec/data-stores.md "Transaction-control statements from the handler") for the EF Core provider,
/// and MySQL's per-process Preview turn-taking.
/// </summary>
public sealed class TransactionControlTests
{
    [Theory]
    [InlineData("COMMIT", false, true)]
    [InlineData("commit work", false, true)]
    [InlineData("COMMIT TRAN", false, true)]
    [InlineData("END", false, true)]
    [InlineData("ROLLBACK", false, true)]
    [InlineData("ROLLBACK TRAN", false, true)]
    [InlineData("ABORT", false, true)]
    [InlineData("BEGIN", false, true)]
    [InlineData("START TRANSACTION", false, true)]
    [InlineData("SET autocommit = 1", false, true)]
    [InlineData("SET SESSION AUTOCOMMIT=1", false, true)]
    [InlineData("INSERT INTO t VALUES (1); COMMIT", false, true)]
    [InlineData("/*!COMMIT*/", true, true)]
    [InlineData("SELECT 'COMMIT; ROLLBACK'", false, false)]
    [InlineData("-- COMMIT\nSELECT 1", false, false)]
    [InlineData("SAVEPOINT s1", false, false)]
    [InlineData("RELEASE SAVEPOINT s1", false, false)]
    [InlineData("ROLLBACK TO SAVEPOINT s1", false, false)]
    [InlineData("ROLLBACK TO s1", false, false)]
    [InlineData("ROLLBACK TRANSACTION [__EFSavePoint]", false, false)]
    [InlineData("INSERT INTO items VALUES ('a', 'COMMIT')", false, false)]
    [InlineData("CREATE TABLE t (a int)", true, true)]
    [InlineData("CREATE TABLE t (a int)", false, false)]
    [InlineData("CREATE TEMPORARY TABLE t (a int)", true, false)]
    [InlineData("LOCK TABLES t WRITE", true, true)]
    [InlineData("TRUNCATE t", true, true)]
    public void StatementsThatEndOrEscapeTheTransactionAreRecognised(string sql, bool mysql, bool refused) =>
        Assert.Equal(refused, SqlStatements.EndsTransaction(sql, mysql));

    [Fact]
    public async Task ARawCommitDuringPreviewNeverReachesTheDatabaseAndFaultsThePreview()
    {
        await using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();
        await using var root = Build(connection);
        await using (var setup = root.CreateAsyncScope())
        {
            await setup.ServiceProvider.GetRequiredService<ExampleContext>().Database.EnsureCreatedAsync();
        }

        await using (var scope = root.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<ExampleContext>();
            var provider = scope.ServiceProvider.GetRequiredService<IPreviewProvider>();
            var recorder = scope.ServiceProvider.GetRequiredService<SendproofPreview>();
            recorder.MarkPreview();
            using var current = root.GetRequiredService<CaptureContext>().Enter(recorder);
            await using var session = await provider.BeginAsync(new DefaultHttpContext { RequestServices = scope.ServiceProvider }, CancellationToken.None);
            db.Items.Add(new Item { Name = "committed?" });
            await db.SaveChangesAsync();

            await Assert.ThrowsAsync<PreviewTransactionControlException>(() => db.Database.ExecuteSqlRawAsync("COMMIT"));
            Assert.IsType<PreviewTransactionControlException>(recorder.Fault);
            await session.RollbackAsync(CancellationToken.None);
        }

        await using var verify = root.CreateAsyncScope();
        Assert.Empty(await verify.ServiceProvider.GetRequiredService<ExampleContext>().Items.ToListAsync());
    }

    [Fact]
    public async Task AHandlerThatCommitsThePreviewTransactionIsRefusedAndTheWriteRollsBack()
    {
        await using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();
        await using var root = Build(connection);
        await using (var setup = root.CreateAsyncScope())
        {
            await setup.ServiceProvider.GetRequiredService<ExampleContext>().Database.EnsureCreatedAsync();
        }

        await using (var scope = root.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<ExampleContext>();
            var provider = scope.ServiceProvider.GetRequiredService<IPreviewProvider>();
            var recorder = scope.ServiceProvider.GetRequiredService<SendproofPreview>();
            recorder.MarkPreview();
            using var current = root.GetRequiredService<CaptureContext>().Enter(recorder);
            await using var session = await provider.BeginAsync(new DefaultHttpContext { RequestServices = scope.ServiceProvider }, CancellationToken.None);
            db.Items.Add(new Item { Name = "committed?" });
            await db.SaveChangesAsync();

            await Assert.ThrowsAsync<PreviewTransactionControlException>(() => db.Database.CommitTransactionAsync());
            Assert.NotNull(recorder.Fault);
            await session.RollbackAsync(CancellationToken.None);
        }

        await using var verify = root.CreateAsyncScope();
        Assert.Empty(await verify.ServiceProvider.GetRequiredService<ExampleContext>().Items.ToListAsync());
    }

    [Fact]
    public async Task TransactionControlOutsideAPreviewIsNeverRefused()
    {
        await using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();
        await using var root = Build(connection);
        await using var scope = root.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ExampleContext>();
        await db.Database.EnsureCreatedAsync();
        await db.Database.ExecuteSqlRawAsync("BEGIN");
        await db.Database.ExecuteSqlRawAsync("COMMIT");
        await using var transaction = await db.Database.BeginTransactionAsync();
        await transaction.CommitAsync();
    }

    [Fact]
    public async Task EfSavepointsInsideAPreviewStayAllowed()
    {
        await using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();
        await using var root = Build(connection);
        await using var scope = root.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ExampleContext>();
        await db.Database.EnsureCreatedAsync();
        var provider = scope.ServiceProvider.GetRequiredService<IPreviewProvider>();
        var recorder = scope.ServiceProvider.GetRequiredService<SendproofPreview>();
        recorder.MarkPreview();
        using var current = root.GetRequiredService<CaptureContext>().Enter(recorder);
        await using var session = await provider.BeginAsync(new DefaultHttpContext { RequestServices = scope.ServiceProvider }, CancellationToken.None);
        await db.Database.ExecuteSqlRawAsync("SAVEPOINT nested");
        await db.Database.ExecuteSqlRawAsync("ROLLBACK TO SAVEPOINT nested");
        Assert.Null(recorder.Fault);
        await session.RollbackAsync(CancellationToken.None);
    }

    [Fact]
    public async Task TheProviderNamesItsSqlSystemForTheWorkbench()
    {
        await using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();
        await using var root = Build(connection);
        await using var scope = root.CreateAsyncScope();
        Assert.Equal("sqlite", scope.ServiceProvider.GetRequiredService<IPreviewProvider>().DatabaseSystem);
    }

    // ---- MySQL turn-taking ----

    [Theory]
    [InlineData("MySql.EntityFrameworkCore", true)]
    [InlineData("Pomelo.EntityFrameworkCore.MySql", true)]
    [InlineData("Microsoft.EntityFrameworkCore.Sqlite", false)]
    [InlineData("Npgsql.EntityFrameworkCore.PostgreSQL", false)]
    [InlineData(null, false)]
    public void OnlyMySqlProvidersNeedATurn(string? providerName, bool expected) => Assert.Equal(expected, PreviewTurns.IsMySql(providerName));

    [Fact]
    public async Task MySqlPreviewsTakeTurnsAndOtherProvidersNeverWait()
    {
        Assert.Null(await PreviewTurns.EnterAsync("Microsoft.EntityFrameworkCore.Sqlite", CancellationToken.None));
        var first = await PreviewTurns.EnterAsync("MySql.EntityFrameworkCore", CancellationToken.None);
        Assert.NotNull(first);
        var second = PreviewTurns.EnterAsync("MySql.EntityFrameworkCore", CancellationToken.None).AsTask();
        await Task.Delay(100);
        Assert.False(second.IsCompleted, "A second MySQL Preview waits for the first one's turn.");
        // An SQLite Preview doesn't queue behind MySQL.
        Assert.Null(await PreviewTurns.EnterAsync("Microsoft.EntityFrameworkCore.Sqlite", CancellationToken.None));
        first!.Dispose();
        first.Dispose(); // Handing the turn back twice must not release someone else's turn.
        var turn = await second.WaitAsync(TimeSpan.FromSeconds(5));
        var third = PreviewTurns.EnterAsync("MySql.EntityFrameworkCore", CancellationToken.None).AsTask();
        await Task.Delay(100);
        Assert.False(third.IsCompleted);
        turn!.Dispose();
        (await third.WaitAsync(TimeSpan.FromSeconds(5)))!.Dispose();
    }

    /// <summary>
    /// The regression: eight concurrent Previews insert the same new key and each rolls back. Without turn-taking
    /// InnoDB aborts all but one with a deadlock (1213). Skips when the compose MySQL service isn't running.
    /// </summary>
    [ServiceFact("mysql")]
    public async Task ConcurrentMySqlPreviewsOfTheSameNewKeyAllSucceed()
    {
        var root = ServiceFactAttribute.MySqlRoot;

        var name = "tb_ef_" + Guid.NewGuid().ToString("N")[..10];
        await using (var admin = new DbContext(new DbContextOptionsBuilder().UseMySQL(root).Options))
        {
            await admin.Database.ExecuteSqlRawAsync($"CREATE DATABASE {name}");
        }

        try
        {
            var services = new ServiceCollection();
            services.AddDbContext<ExampleContext>(options => options.UseMySQL($"{root};database={name};Pooling=true"));
            services.AddSendproof().AddEntityFrameworkCore<ExampleContext>();
            await using var provider = services.BuildServiceProvider();
            await using (var setup = provider.CreateAsyncScope())
            {
                await setup.ServiceProvider.GetRequiredService<ExampleContext>().Database.EnsureCreatedAsync();
            }

            var previews = Enumerable.Range(0, 8).Select(async _ =>
            {
                await using var scope = provider.CreateAsyncScope();
                var db = scope.ServiceProvider.GetRequiredService<ExampleContext>();
                var preview = scope.ServiceProvider.GetRequiredService<IPreviewProvider>();
                await using var session = await preview.BeginAsync(new DefaultHttpContext { RequestServices = scope.ServiceProvider }, CancellationToken.None);
                db.Items.Add(new Item { Id = "same-key", Name = "preview" });
                await db.SaveChangesAsync();
                await session.RollbackAsync(CancellationToken.None);
            }).ToArray();
            await Task.WhenAll(previews);

            await using var verify = provider.CreateAsyncScope();
            Assert.Empty(await verify.ServiceProvider.GetRequiredService<ExampleContext>().Items.ToListAsync());
        }
        finally
        {
            await using var admin = new DbContext(new DbContextOptionsBuilder().UseMySQL(root).Options);
            await admin.Database.ExecuteSqlRawAsync($"DROP DATABASE IF EXISTS {name}");
        }
    }

    private static ServiceProvider Build(SqliteConnection connection)
    {
        var services = new ServiceCollection();
        services.AddDbContext<ExampleContext>(options => options.UseSqlite(connection));
        services.AddSendproof().AddEntityFrameworkCore<ExampleContext>();
        return services.BuildServiceProvider();
    }

    public sealed class ExampleContext(DbContextOptions options) : DbContext(options)
    {
        public DbSet<Item> Items => Set<Item>();

        protected override void OnModelCreating(ModelBuilder modelBuilder) =>
            modelBuilder.Entity<Item>().Property(item => item.Id).HasMaxLength(64);
    }

    public sealed class Item
    {
        public string Id { get; set; } = Guid.NewGuid().ToString("N");
        public string Name { get; set; } = "";
    }
}
