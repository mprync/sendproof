using Microsoft.AspNetCore.Http;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Sendproof.AspNetCore;
using Sendproof.EntityFrameworkCore;
using Xunit;

namespace Sendproof.EntityFrameworkCore.Tests;

public sealed class PreviewProviderTests
{
    [Fact]
    public void DatabaseLabelUsesOnlySqliteFileName()
    {
        var services = new ServiceCollection();
        services.AddDbContext<ExampleContext>(options => options.UseSqlite("Data Source=/private/secret/treasury.db"));
        services.AddSendproof().AddEntityFrameworkCore<ExampleContext>();
        using var root = services.BuildServiceProvider();
        using var scope = root.CreateScope();
        var provider = scope.ServiceProvider.GetRequiredService<IPreviewProvider>();
        Assert.True(provider.IsAvailable);
        Assert.Equal("treasury.db", provider.Database);
    }

    [Fact]
    public async Task NonRelationalProviderIsUnavailableAndCannotStartPreview()
    {
        var services = new ServiceCollection();
        services.AddDbContext<ExampleContext>(options => options.UseInMemoryDatabase("example"));
        services.AddSendproof().AddEntityFrameworkCore<ExampleContext>();
        using var root = services.BuildServiceProvider();
        using var scope = root.CreateScope();
        var provider = scope.ServiceProvider.GetRequiredService<IPreviewProvider>();
        Assert.False(provider.IsAvailable);
        Assert.Null(provider.Database);
        var request = new DefaultHttpContext { RequestServices = scope.ServiceProvider };
        await Assert.ThrowsAsync<InvalidOperationException>(async () =>
            await provider.BeginAsync(request, CancellationToken.None));
    }

    [Fact]
    public async Task CapturesRepeatedSavesAndGeneratedKeysAndRollsBackRealWrites()
    {
        await using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();
        var services = new ServiceCollection();
        services.AddDbContext<ExampleContext>(options => options.UseSqlite(connection));
        services.AddSendproof().AddEntityFrameworkCore<ExampleContext>();
        await using var root = services.BuildServiceProvider();

        await using (var setup = root.CreateAsyncScope())
        {
            var db = setup.ServiceProvider.GetRequiredService<ExampleContext>();
            await db.Database.EnsureCreatedAsync();
            db.Items.Add(new Item { Name = "original" });
            await db.SaveChangesAsync();
        }

        await using (var scope = root.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<ExampleContext>();
            var provider = scope.ServiceProvider.GetRequiredService<IPreviewProvider>();
            Assert.Equal("In-memory SQLite", provider.Database);
            var request = new DefaultHttpContext { RequestServices = scope.ServiceProvider };
            await using var session = await provider.BeginAsync(request, CancellationToken.None);
            var existing = await db.Items.SingleAsync();
            existing.Name = "changed";
            var added = new Item { Name = "new" };
            db.Items.Add(added);
            await db.SaveChangesAsync();
            Assert.True(added.Id > 0);
            added.Name = "newer";
            db.Items.Remove(existing);
            db.SaveChanges();

            await session.RollbackAsync(CancellationToken.None);
            Assert.Equal(4, session.Changes.Count);
            var insert = Assert.Single(session.Changes, change => change.Operation == "insert");
            Assert.Equal("Items", insert.Table);
            Assert.Equal(added.Id, Fields(insert.Key)[nameof(Item.Id)]);
            Assert.Null(insert.Before);
            Assert.Equal("new", Fields(insert.After)[nameof(Item.Name)]);
            var updates = session.Changes.Where(change => change.Operation == "update").ToArray();
            Assert.Equal(2, updates.Length);
            Assert.Equal("original", Fields(updates[0].Before)[nameof(Item.Name)]);
            Assert.Equal("changed", Fields(updates[0].After)[nameof(Item.Name)]);
            Assert.Equal("new", Fields(updates[1].Before)[nameof(Item.Name)]);
            Assert.Equal("newer", Fields(updates[1].After)[nameof(Item.Name)]);
            var deleted = Assert.Single(session.Changes, change => change.Operation == "delete");
            Assert.Equal("changed", Fields(deleted.Before)[nameof(Item.Name)]);
            Assert.Null(deleted.After);
        }

        await using var verification = root.CreateAsyncScope();
        var remaining = await verification.ServiceProvider.GetRequiredService<ExampleContext>().Items.SingleAsync();
        Assert.Equal("original", remaining.Name);
    }

    [Fact]
    public async Task ChangeSnapshotsRedactSecretNamedColumnsInEveryEnvironment()
    {
        await using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();
        var services = new ServiceCollection();
        services.AddDbContext<ExampleContext>(options => options.UseSqlite(connection));
        services.AddSendproof().AddEntityFrameworkCore<ExampleContext>();
        await using var root = services.BuildServiceProvider();

        await using (var setup = root.CreateAsyncScope())
        {
            var db = setup.ServiceProvider.GetRequiredService<ExampleContext>();
            await db.Database.EnsureCreatedAsync();
            db.Accounts.Add(new Account { Email = "ada@example.test", PasswordHash = "old-hash-value", ApiKey = "old-api-key" });
            await db.SaveChangesAsync();
        }

        await using var scope = root.CreateAsyncScope();
        var context = scope.ServiceProvider.GetRequiredService<ExampleContext>();
        var provider = scope.ServiceProvider.GetRequiredService<IPreviewProvider>();
        await using var session = await provider.BeginAsync(new DefaultHttpContext { RequestServices = scope.ServiceProvider }, CancellationToken.None);
        var account = await context.Accounts.SingleAsync();
        account.PasswordHash = "new-hash-value";
        account.ApiKey = "new-api-key";
        context.Accounts.Add(new Account { Email = "grace@example.test", PasswordHash = "inserted-hash", ApiKey = "inserted-key" });
        await context.SaveChangesAsync();
        await session.RollbackAsync(CancellationToken.None);

        Assert.Equal(2, session.Changes.Count);
        foreach (var change in session.Changes)
        {
            foreach (var snapshot in new[] { change.Before, change.After }.Where(value => value is not null))
            {
                var fields = Fields(snapshot);
                Assert.Equal("[REDACTED]", fields[nameof(Account.PasswordHash)]);
                Assert.Equal("[REDACTED]", fields[nameof(Account.ApiKey)]);
                Assert.Contains("@example.test", Assert.IsType<string>(fields[nameof(Account.Email)]));
            }
        }
    }

    private static Dictionary<string, object?> Fields(object? value) =>
        Assert.IsType<Dictionary<string, object?>>(value);

    public sealed class ExampleContext(DbContextOptions<ExampleContext> options) : DbContext(options)
    {
        public DbSet<Item> Items => Set<Item>();
        public DbSet<Account> Accounts => Set<Account>();
    }

    public sealed class Account
    {
        public int Id { get; set; }
        public string Email { get; set; } = "";
        public string PasswordHash { get; set; } = "";
        public string ApiKey { get; set; } = "";
    }

    public sealed class Item
    {
        public int Id { get; set; }
        public string Name { get; set; } = "";
    }
}
