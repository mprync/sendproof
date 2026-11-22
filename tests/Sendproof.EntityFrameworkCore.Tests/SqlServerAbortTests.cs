using Microsoft.AspNetCore.Http;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Sendproof.AspNetCore;
using Xunit;
using static Sendproof.EntityFrameworkCore.Tests.TransactionControlTests;

namespace Sendproof.EntityFrameworkCore.Tests;

/// <summary>
/// spec/data-stores.md "Transaction-control statements from the handler": when SQL Server ends the Preview transaction
/// on its own (deadlock victim 1205, or any error under <c>XACT_ABORT ON</c>), every further statement in the Preview is
/// refused and the Preview fails, even though the handler caught the error. Runs against the compose SQL Server service.
/// </summary>
public sealed class SqlServerAbortTests
{
    private sealed record Run(ServiceProvider Services, string Database) : IAsyncDisposable
    {
        public async ValueTask DisposeAsync()
        {
            await Services.DisposeAsync();
            SqlConnection.ClearAllPools();
            await using var admin = new SqlConnection(ServiceFactAttribute.SqlServerRoot);
            await admin.OpenAsync();
            await using var drop = admin.CreateCommand();
            drop.CommandText = $"ALTER DATABASE [{Database}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [{Database}]";
            await drop.ExecuteNonQueryAsync();
        }
    }

    private static async Task<Run> StartAsync()
    {
        var name = "tb_ef_" + Guid.NewGuid().ToString("N")[..10];
        var services = new ServiceCollection();
        services.AddDbContext<ExampleContext>(options => options.UseSqlServer($"{ServiceFactAttribute.SqlServerRoot};Database={name}"));
        services.AddSendproof().AddEntityFrameworkCore<ExampleContext>();
        var provider = services.BuildServiceProvider();
        await using var setup = provider.CreateAsyncScope();
        var db = setup.ServiceProvider.GetRequiredService<ExampleContext>();
        await db.Database.EnsureCreatedAsync();
        db.Items.AddRange(new Item { Id = "a", Name = "a" }, new Item { Id = "b", Name = "b" });
        await db.SaveChangesAsync();
        return new Run(provider, name);
    }

    private static async Task<int> CountAsync(Run run, string id)
    {
        await using var scope = run.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<ExampleContext>().Items.CountAsync(item => item.Id == id);
    }

    /// <summary>Runs <paramref name="handler"/> as a Preview's handler and returns the Preview's recorded fault.</summary>
    private static async Task<Exception?> PreviewAsync(Run run, Func<ExampleContext, Task> handler)
    {
        await using var scope = run.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ExampleContext>();
        var recorder = scope.ServiceProvider.GetRequiredService<SendproofPreview>();
        recorder.MarkPreview();
        using var current = run.Services.GetRequiredService<CaptureContext>().Enter(recorder);
        await using var session = await scope.ServiceProvider.GetRequiredService<IPreviewProvider>()
            .BeginAsync(new DefaultHttpContext { RequestServices = scope.ServiceProvider }, CancellationToken.None);
        await handler(db);
        try
        {
            await session.RollbackAsync(CancellationToken.None);
        }
        catch (Exception)
        {
            // The server already ended the transaction; the recorded fault is what fails the Preview.
        }

        return recorder.Fault;
    }

    /// <summary>The handler's retry after the server ended the transaction: refused before sending.</summary>
    private static async Task RetryIsRefusedAsync(ExampleContext db, string id)
    {
        await Assert.ThrowsAsync<PreviewTransactionControlException>(() =>
            db.Database.ExecuteSqlAsync($"INSERT INTO Items (Id, Name) VALUES ({id}, 'x')"));
        db.Items.Add(new Item { Id = id + "-ef", Name = "x" });
        await Assert.ThrowsAnyAsync<Exception>(() => db.SaveChangesAsync());
    }

    [ServiceFact("sqlserver")]
    public async Task AfterTheDeadlockVictimErrorEveryFurtherStatementIsRefused()
    {
        await using var run = await StartAsync();
        await using var other = new SqlConnection($"{ServiceFactAttribute.SqlServerRoot};Database={run.Database}");
        await other.OpenAsync();
        await using var otherTransaction = (SqlTransaction)await other.BeginTransactionAsync();
        Task OtherAsync(string sql)
        {
            var command = new SqlCommand(sql, other, otherTransaction);
            return command.ExecuteNonQueryAsync();
        }

        await OtherAsync("UPDATE Items SET Name = 'other' WHERE Id = 'b'");
        Exception? original = null;
        var fault = await PreviewAsync(run, async db =>
        {
            // The Preview is made the victim, as a lower-priority session would be.
            await db.Database.ExecuteSqlRawAsync("SET DEADLOCK_PRIORITY LOW");
            await db.Database.ExecuteSqlRawAsync("UPDATE Items SET Name = 'preview' WHERE Id = 'a'");
            var blocked = OtherAsync("UPDATE Items SET Name = 'other' WHERE Id = 'a'");
            await Task.Delay(300);
            original = await Record.ExceptionAsync(() => db.Database.ExecuteSqlRawAsync("UPDATE Items SET Name = 'preview' WHERE Id = 'b'"));
            await blocked;
            await RetryIsRefusedAsync(db, "retry");
        });
        await otherTransaction.RollbackAsync();

        Assert.Equal(1205, Assert.IsType<SqlException>(original).Number);
        Assert.NotNull(fault);
        Assert.Equal(0, await CountAsync(run, "retry"));
    }

    [ServiceFact("sqlserver")]
    public async Task AnErrorUnderXactAbortEndsThePreviewAndEveryFurtherStatementIsRefused()
    {
        await using var run = await StartAsync();
        var fault = await PreviewAsync(run, async db =>
        {
            await db.Database.ExecuteSqlRawAsync("SET XACT_ABORT ON");
            // A duplicate key: under XACT_ABORT ON the server rolls the whole transaction back.
            var error = await Record.ExceptionAsync(() => db.Database.ExecuteSqlRawAsync("INSERT INTO Items (Id, Name) VALUES ('a', 'dup')"));
            Assert.IsType<SqlException>(error);
            await RetryIsRefusedAsync(db, "after-abort");
        });

        Assert.NotNull(fault);
        Assert.Equal(0, await CountAsync(run, "after-abort"));
    }

    [ServiceFact("sqlserver")]
    public async Task AnErrorThatKeepsTheTransactionLeavesThePreviewConfirmable()
    {
        await using var run = await StartAsync();
        var fault = await PreviewAsync(run, async db =>
        {
            var error = await Record.ExceptionAsync(() => db.Database.ExecuteSqlRawAsync("INSERT INTO Items (Id, Name) VALUES ('a', 'dup')"));
            Assert.IsType<SqlException>(error);
            await db.Database.ExecuteSqlRawAsync("INSERT INTO Items (Id, Name) VALUES ('fine', 'x')");
        });

        Assert.Null(fault);
        Assert.Equal(0, await CountAsync(run, "fine"));
    }
}
