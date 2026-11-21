using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using MongoDB.Driver;
using MongoDB.EntityFrameworkCore.Extensions;
using Sendproof.AspNetCore;
using Sendproof.EntityFrameworkCore;
using Xunit;

namespace Sendproof.EntityFrameworkCore.Tests;

/// <summary>
/// The EF Core MongoDB provider spike (docs/plans/data-stores.md): <c>Database.BeginTransaction()</c> is supported on a replica
/// set, so the existing provider covers it after one change, accepting this non-relational provider. Needs the compose
/// MongoDB replica set.
/// </summary>
public sealed class MongoProviderTests
{
    [ServiceFact("mongodb")]
    public async Task ThePreviewProviderRollsBackAndCapturesChangesThroughTheEfMongoProvider()
    {
        var name = "tb_ef_" + Guid.NewGuid().ToString("N")[..10];
        var client = new MongoClient(ServiceFactAttribute.MongoUrl);
        try
        {
            var services = new ServiceCollection();
            services.AddDbContext<NotesContext>(options => options.UseMongoDB(client, name));
            services.AddSendproof().AddEntityFrameworkCore<NotesContext>();
            await using var root = services.BuildServiceProvider();

            await using var scope = root.CreateAsyncScope();
            var db = scope.ServiceProvider.GetRequiredService<NotesContext>();
            var provider = scope.ServiceProvider.GetRequiredService<IPreviewProvider>();
            Assert.True(provider.IsAvailable);
            Assert.Null(provider.Database);
            await using (var session = await provider.BeginAsync(new DefaultHttpContext { RequestServices = scope.ServiceProvider }, CancellationToken.None))
            {
                db.Notes.Add(new Note { Id = "n1", Text = "draft" });
                await db.SaveChangesAsync();
                await session.RollbackAsync(CancellationToken.None);
                var change = Assert.Single(session.Changes);
                Assert.Equal(("insert", "notes", "mongodb"), (change.Operation, change.Table, change.Store));
            }

            var stored = await client.GetDatabase(name).GetCollection<MongoDB.Bson.BsonDocument>("notes").CountDocumentsAsync(FilterDefinition<MongoDB.Bson.BsonDocument>.Empty);
            Assert.Equal(0, stored);
        }
        finally
        {
            await client.DropDatabaseAsync(name);
        }
    }

    public sealed class Note
    {
        public string Id { get; set; } = "";
        public string Text { get; set; } = "";
    }

    public sealed class NotesContext(DbContextOptions<NotesContext> options) : DbContext(options)
    {
        public DbSet<Note> Notes => Set<Note>();

        protected override void OnModelCreating(ModelBuilder modelBuilder) => modelBuilder.Entity<Note>().ToCollection("notes");
    }
}
