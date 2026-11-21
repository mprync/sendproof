using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage.ValueConversion;

namespace TreasuryApi;

/// <summary>The disposable database used by the Treasury demonstration.</summary>
public sealed class TreasuryDbContext(DbContextOptions<TreasuryDbContext> options) : DbContext(options)
{
    /// <summary>Demo users, including password hashes and roles.</summary>
    public DbSet<DemoUser> Users => Set<DemoUser>();
    /// <summary>Bank accounts and their balances.</summary>
    public DbSet<AccountRecord> Accounts => Set<AccountRecord>();
    /// <summary>Intraday balance history.</summary>
    public DbSet<BalanceSnapshotRecord> BalanceSnapshots => Set<BalanceSnapshotRecord>();
    /// <summary>Payment recipients.</summary>
    public DbSet<CounterpartyRecord> Counterparties => Set<CounterpartyRecord>();
    /// <summary>Payments in every status.</summary>
    public DbSet<PaymentRecord> Payments => Set<PaymentRecord>();
    /// <summary>Reviewer decisions on payments.</summary>
    public DbSet<PaymentApprovalRecord> PaymentApprovals => Set<PaymentApprovalRecord>();
    /// <summary>Foreign exchange deals.</summary>
    public DbSet<FxDealRecord> FxDeals => Set<FxDealRecord>();
    /// <summary>Daily bank statements.</summary>
    public DbSet<BankStatementRecord> BankStatements => Set<BankStatementRecord>();
    /// <summary>Lines of the bank statements.</summary>
    public DbSet<StatementEntryRecord> StatementEntries => Set<StatementEntryRecord>();
    /// <summary>Audit events for payments and other changes.</summary>
    public DbSet<AuditEventRecord> AuditEvents => Set<AuditEventRecord>();

    /// <inheritdoc />
    protected override void ConfigureConventions(ModelConfigurationBuilder configuration)
    {
        // SQLite cannot sort or compare decimal columns, so money is stored as REAL and read back as decimal.
        configuration.Properties<decimal>().HaveConversion<double>();
        configuration.Properties<Currency>().HaveConversion<string>().HaveMaxLength(3);
        configuration.Properties<AccountType>().HaveConversion<string>();
        configuration.Properties<AccountStatus>().HaveConversion<string>();
        configuration.Properties<CounterpartyType>().HaveConversion<string>();
        configuration.Properties<CounterpartyStatus>().HaveConversion<string>();
        configuration.Properties<PaymentStatus>().HaveConversion<string>();
        configuration.Properties<Priority>().HaveConversion<string>();
        configuration.Properties<ChargeBearer>().HaveConversion<string>();
        configuration.Properties<PurposeCode>().HaveConversion<string>();
        configuration.Properties<ApprovalDecision>().HaveConversion<string>();
        configuration.Properties<FxDealType>().HaveConversion<string>();
        configuration.Properties<FxSide>().HaveConversion<string>();
        configuration.Properties<FxPair>().HaveConversion<string>();
        configuration.Properties<FxDealStatus>().HaveConversion<string>();
        configuration.Properties<StatementEntryType>().HaveConversion<string>();
        configuration.Properties<BankScheme>().HaveConversion<string>();
        // SQLite has no native DateTimeOffset ordering either; store ticks so ORDER BY works.
        configuration.Properties<DateTimeOffset>().HaveConversion<DateTimeOffsetToBinaryConverter>();
    }

    /// <inheritdoc />
    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<DemoUser>().HasIndex(u => u.Email).IsUnique();
        modelBuilder.Entity<AccountRecord>().HasIndex(a => a.Iban).IsUnique();
        modelBuilder.Entity<PaymentRecord>().HasIndex(p => p.IdempotencyKey).IsUnique();
        modelBuilder.Entity<PaymentRecord>().HasIndex(p => p.Number).IsUnique();
        modelBuilder.Entity<PaymentRecord>().HasIndex(p => new { p.Status, p.ValueDate });
        modelBuilder.Entity<PaymentApprovalRecord>().HasIndex(a => a.PaymentId);
        modelBuilder.Entity<BalanceSnapshotRecord>().HasIndex(s => new { s.AccountId, s.AsOf });
        modelBuilder.Entity<BankStatementRecord>().HasIndex(s => new { s.AccountId, s.StatementDate }).IsUnique();
        modelBuilder.Entity<BankStatementRecord>().HasMany(s => s.Entries).WithOne().HasForeignKey(e => e.StatementId);
    }
}
