using Microsoft.EntityFrameworkCore;

namespace DotnetConformance;

/// <summary>The single conformance table: <c>items(id, name)</c>.</summary>
public sealed class Item
{
    /// <summary>Gets or sets the string primary key.</summary>
    public string Id { get; set; } = "";

    /// <summary>Gets or sets the display name.</summary>
    public string Name { get; set; } = "";
}

/// <summary>EF Core context over a disposable SQLite file.</summary>
public sealed class FixtureDbContext(DbContextOptions<FixtureDbContext> options) : DbContext(options)
{
    /// <summary>Gets the items table.</summary>
    public DbSet<Item> Items => Set<Item>();

    /// <inheritdoc />
    protected override void OnModelCreating(ModelBuilder modelBuilder) => modelBuilder.Entity<Item>(item =>
    {
        item.ToTable("items");
        item.HasKey(i => i.Id);
        item.Property(i => i.Id).HasColumnName("id");
        item.Property(i => i.Name).HasColumnName("name").IsRequired();
    });
}

/// <summary>An in-memory stand-in for an external delivery channel; effects delivered by ordinary Send land here.</summary>
public sealed class FixtureOutbox
{
    private readonly System.Collections.Concurrent.ConcurrentQueue<string> _messages = new();

    /// <summary>Gets the descriptions delivered in this process.</summary>
    public IReadOnlyCollection<string> Messages => _messages.ToArray();

    internal void Deliver(string description) => _messages.Enqueue(description);
}
