using Microsoft.EntityFrameworkCore;

namespace DotnetConformance;

/// <summary>A conformance table: <c>items(id, name)</c>.</summary>
public sealed class Item
{
    /// <summary>Gets or sets the string primary key.</summary>
    public string Id { get; set; } = "";

    /// <summary>Gets or sets the display name.</summary>
    public string Name { get; set; } = "";
}

/// <summary>
/// The second conformance table, <c>accounts(id, email, password_hash)</c>, for the shared secret-columns rule. Change snapshots
/// are keyed by property name, and the contract names the column (<c>after.password_hash</c>), so the properties use the column names.
/// </summary>
#pragma warning disable IDE1006
public sealed class Account
{
    /// <summary>Gets or sets the string primary key.</summary>
    public string id { get; set; } = "";

    /// <summary>Gets or sets the email.</summary>
    public string email { get; set; } = "";

    /// <summary>Gets or sets the stored password hash, which captures must never show.</summary>
    public string password_hash { get; set; } = "";
}
#pragma warning restore IDE1006

/// <summary>EF Core context over a disposable SQLite file, or a disposable MySQL database.</summary>
public sealed class FixtureDbContext(DbContextOptions<FixtureDbContext> options) : DbContext(options)
{
    /// <summary>Gets the items table.</summary>
    public DbSet<Item> Items => Set<Item>();

    /// <summary>Gets the accounts table.</summary>
    public DbSet<Account> Accounts => Set<Account>();

    /// <inheritdoc />
    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        // A bounded key: MySQL can't index an unbounded string column.
        modelBuilder.Entity<Item>(item =>
        {
            item.ToTable("items");
            item.HasKey(i => i.Id);
            item.Property(i => i.Id).HasColumnName("id").HasMaxLength(255);
            item.Property(i => i.Name).HasColumnName("name").IsRequired().HasMaxLength(1024);
        });
        modelBuilder.Entity<Account>(account =>
        {
            account.ToTable("accounts");
            account.HasKey(a => a.id);
            account.Property(a => a.id).HasColumnName("id").HasMaxLength(255);
            account.Property(a => a.email).HasColumnName("email").IsRequired().HasMaxLength(255);
            account.Property(a => a.password_hash).HasColumnName("password_hash").IsRequired().HasMaxLength(255);
        });
    }
}

/// <summary>An in-memory stand-in for an external delivery channel; effects delivered by ordinary Send land here.</summary>
public sealed class FixtureOutbox
{
    private readonly System.Collections.Concurrent.ConcurrentQueue<string> _messages = new();

    /// <summary>Gets the descriptions delivered in this process.</summary>
    public IReadOnlyCollection<string> Messages => _messages.ToArray();

    internal void Deliver(string description) => _messages.Enqueue(description);
}
