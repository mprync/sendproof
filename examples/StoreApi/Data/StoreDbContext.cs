using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage.ValueConversion;

namespace StoreApi;

/// <summary>The disposable database used by the Acme Store demonstration.</summary>
public sealed class StoreDbContext(DbContextOptions<StoreDbContext> options) : DbContext(options)
{
    /// <summary>Demo users, including password hashes and roles.</summary>
    public DbSet<DemoUser> Users => Set<DemoUser>();
    /// <summary>Product categories.</summary>
    public DbSet<CategoryRecord> Categories => Set<CategoryRecord>();
    /// <summary>Products.</summary>
    public DbSet<ProductRecord> Products => Set<ProductRecord>();
    /// <summary>Product variants, one per SKU.</summary>
    public DbSet<VariantRecord> Variants => Set<VariantRecord>();
    /// <summary>Variant prices, one per currency.</summary>
    public DbSet<PriceRecord> Prices => Set<PriceRecord>();
    /// <summary>Stock levels.</summary>
    public DbSet<StockRecord> Stock => Set<StockRecord>();
    /// <summary>Stock movements.</summary>
    public DbSet<StockMovementRecord> StockMovements => Set<StockMovementRecord>();
    /// <summary>Stock reservations.</summary>
    public DbSet<ReservationRecord> Reservations => Set<ReservationRecord>();
    /// <summary>Customer profiles.</summary>
    public DbSet<CustomerRecord> Customers => Set<CustomerRecord>();
    /// <summary>Customer addresses.</summary>
    public DbSet<AddressRecord> Addresses => Set<AddressRecord>();
    /// <summary>Open carts.</summary>
    public DbSet<CartRecord> Carts => Set<CartRecord>();
    /// <summary>Cart lines.</summary>
    public DbSet<CartItemRecord> CartItems => Set<CartItemRecord>();
    /// <summary>Orders.</summary>
    public DbSet<OrderRecord> Orders => Set<OrderRecord>();
    /// <summary>Order lines.</summary>
    public DbSet<OrderLineRecord> OrderLines => Set<OrderLineRecord>();
    /// <summary>Payments.</summary>
    public DbSet<PaymentRecord> Payments => Set<PaymentRecord>();
    /// <summary>Refunds.</summary>
    public DbSet<RefundRecord> Refunds => Set<RefundRecord>();
    /// <summary>Shipments.</summary>
    public DbSet<ShipmentRecord> Shipments => Set<ShipmentRecord>();
    /// <summary>Coupons.</summary>
    public DbSet<CouponRecord> Coupons => Set<CouponRecord>();
    /// <summary>Audit events for orders and other changes.</summary>
    public DbSet<AuditEventRecord> AuditEvents => Set<AuditEventRecord>();

    /// <inheritdoc />
    protected override void ConfigureConventions(ModelConfigurationBuilder configuration)
    {
        // SQLite cannot sort or compare decimal columns, so money is stored as REAL and read back as decimal.
        configuration.Properties<decimal>().HaveConversion<double>();
        configuration.Properties<Currency>().HaveConversion<string>().HaveMaxLength(3);
        configuration.Properties<Currency?>().HaveConversion<string>().HaveMaxLength(3);
        configuration.Properties<ProductStatus>().HaveConversion<string>();
        configuration.Properties<OrderStatus>().HaveConversion<string>();
        configuration.Properties<PaymentStatus>().HaveConversion<string>();
        configuration.Properties<PaymentMethodKind>().HaveConversion<string>();
        configuration.Properties<ShippingSpeed>().HaveConversion<string>();
        configuration.Properties<Carrier>().HaveConversion<string>();
        configuration.Properties<ShipmentStatus>().HaveConversion<string>();
        configuration.Properties<AddressKind>().HaveConversion<string>();
        configuration.Properties<CustomerTier>().HaveConversion<string>();
        configuration.Properties<StockReason>().HaveConversion<string>();
        configuration.Properties<ReservationStatus>().HaveConversion<string>();
        configuration.Properties<RefundReason>().HaveConversion<string>();
        configuration.Properties<CouponKind>().HaveConversion<string>();
        // SQLite has no native DateTimeOffset ordering either; store ticks so ORDER BY works.
        configuration.Properties<DateTimeOffset>().HaveConversion<DateTimeOffsetToBinaryConverter>();
    }

    /// <inheritdoc />
    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<DemoUser>().HasIndex(u => u.Email).IsUnique();
        modelBuilder.Entity<CategoryRecord>().HasIndex(c => c.Slug).IsUnique();
        modelBuilder.Entity<ProductRecord>().HasIndex(p => p.Slug).IsUnique();
        modelBuilder.Entity<ProductRecord>().HasIndex(p => new { p.Status, p.CategoryId });
        modelBuilder.Entity<VariantRecord>().HasIndex(v => v.Sku).IsUnique();
        modelBuilder.Entity<VariantRecord>().HasIndex(v => v.ProductId);
        modelBuilder.Entity<PriceRecord>().HasIndex(p => new { p.VariantId, p.Currency }).IsUnique();
        modelBuilder.Entity<StockRecord>().HasIndex(s => s.VariantId).IsUnique();
        modelBuilder.Entity<StockMovementRecord>().HasIndex(m => new { m.VariantId, m.CreatedAt });
        modelBuilder.Entity<ReservationRecord>().HasIndex(r => new { r.VariantId, r.Status });
        modelBuilder.Entity<CustomerRecord>().HasIndex(c => c.Email).IsUnique();
        modelBuilder.Entity<AddressRecord>().HasIndex(a => a.CustomerId);
        modelBuilder.Entity<CartRecord>().HasIndex(c => c.CustomerId).IsUnique();
        modelBuilder.Entity<CartItemRecord>().HasIndex(i => new { i.CartId, i.VariantId }).IsUnique();
        modelBuilder.Entity<OrderRecord>().HasIndex(o => o.Number).IsUnique();
        modelBuilder.Entity<OrderRecord>().HasIndex(o => o.IdempotencyKey).IsUnique();
        modelBuilder.Entity<OrderRecord>().HasIndex(o => new { o.CustomerId, o.PlacedAt });
        modelBuilder.Entity<OrderLineRecord>().HasIndex(l => l.OrderId);
        modelBuilder.Entity<PaymentRecord>().HasIndex(p => p.OrderId);
        modelBuilder.Entity<RefundRecord>().HasIndex(r => r.PaymentId);
        modelBuilder.Entity<ShipmentRecord>().HasIndex(s => s.OrderId);
        modelBuilder.Entity<CouponRecord>().HasIndex(c => c.Code).IsUnique();
    }
}
