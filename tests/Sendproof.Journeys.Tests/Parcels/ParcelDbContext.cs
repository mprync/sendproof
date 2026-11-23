using Microsoft.EntityFrameworkCore;

namespace Sendproof.Journeys.Tests;

/// <summary>The test API's database. Its table has a name of its own, so the tests show names come from the model.</summary>
public sealed class ParcelDbContext(DbContextOptions<ParcelDbContext> options) : DbContext(options)
{
    public DbSet<Parcel> Parcels => Set<Parcel>();

    protected override void OnModelCreating(ModelBuilder modelBuilder) => modelBuilder.Entity<Parcel>().ToTable("parcel_rows");
}
