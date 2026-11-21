using Microsoft.AspNetCore.Identity;

namespace TreasuryApi;

/// <summary>
/// Seeds a newly created database with a believable, deterministic corporate-treasury data set: people, bank
/// accounts, counterparties, payments in every status, FX deals and bank statements.
/// </summary>
/// <remarks>
/// The same random seed is used on every run, so ids, names and amounts are identical between databases; only dates
/// move, because they are relative to the day the database is created. Operating EUR always has exactly 250,000.00 available and no
/// open payments, so the tests and examples that pay from it stay valid.
/// </remarks>
internal static class DemoData
{
    /// <summary>The password of every seeded user.</summary>
    internal const string Password = "Demo123!";
    /// <summary>The ID of the <c>Operating EUR</c> account, which starts with 250,000.00 available.</summary>
    internal const string OperatingEurId = "3f9c0000-0000-4000-8000-00000000a21e";
    /// <summary>The ID of the <c>Operating USD</c> account.</summary>
    internal const string OperatingUsdId = "3f9c0000-0000-4000-8000-00000000a21f";
    /// <summary>The ID of the <c>Northwind Logistics GmbH</c> counterparty.</summary>
    internal const string NorthwindId = "5b7c0000-0000-4000-8000-00000000b123";

    private const int RandomSeed = 20260101;

    /// <summary>Creates the schema and fills it. Only a newly created database file is ever passed in.</summary>
    internal static async Task SeedAsync(IServiceProvider services)
    {
        var db = services.GetRequiredService<TreasuryDbContext>();
        // Only a newly created file is initialized; never seed an existing database.
        await db.Database.EnsureCreatedAsync();
        var hasher = services.GetRequiredService<IPasswordHasher<DemoUser>>();
        var rng = new Random(RandomSeed);
        var now = DateTimeOffset.UtcNow;
        var today = DateOnly.FromDateTime(now.UtcDateTime);

        var users = SeedUsers(hasher);
        db.Users.AddRange(users);
        var accounts = AccountSeed.Create(rng, today);
        var counterparties = CounterpartySeed.Create(rng, now, accounts);
        db.Accounts.AddRange(accounts);
        db.Counterparties.AddRange(counterparties);
        var payments = PaymentSeed.Create(rng, now, today, users, accounts, counterparties);
        db.BalanceSnapshots.AddRange(AccountSeed.ApplyReservations(rng, now, accounts, payments.Reserved));
        db.Payments.AddRange(payments.Payments);
        db.PaymentApprovals.AddRange(payments.Approvals);
        db.AuditEvents.AddRange(payments.Audit);
        db.FxDeals.AddRange(FxSeed.Create(rng, now, today, users));
        db.BankStatements.AddRange(StatementSeed.Create(rng, now, today, accounts, payments.Payments, counterparties));
        await db.SaveChangesAsync();
    }

    private static List<DemoUser> SeedUsers(IPasswordHasher<DemoUser> hasher)
    {
        var users = new List<DemoUser>();
        foreach (var (email, name, role, title, active) in new (string, string, string, string, bool)[]
        {
            ("ada.admin@acme.dev", "Ada Admin", "admin", "Group Treasury Director", true),
            ("ben.approver@acme.dev", "Ben Approver", "payments.approve", "Treasury Manager", true),
            ("cara.viewer@acme.dev", "Cara Viewer", "read-only", "Finance Analyst", true),
            ("devi.approver@acme.dev", "Devi Approver", "payments.approve", "Head of Cash Management", true),
            ("tomas.treasurer@acme.dev", "Tomás Treasurer", "payments.approve", "Senior Treasury Analyst", true),
            ("ines.auditor@acme.dev", "Inês Auditor", "read-only", "Internal Audit", true),
            ("liam.payables@acme.dev", "Liam Payables", "read-only", "Accounts Payable Lead", true),
            ("greta.former@acme.dev", "Greta Former", "read-only", "Former Treasury Analyst", false)
        })
        {
            var user = new DemoUser { Email = email, Name = name, Role = role, JobTitle = title, IsActive = active, PasswordHash = "" };
            user.PasswordHash = hasher.HashPassword(user, Password);
            users.Add(user);
        }
        return users;
    }
}

/// <summary>Small helpers for drawing deterministic random values.</summary>
internal static class SeedRandom
{
    /// <summary>Picks one element.</summary>
    internal static T Pick<T>(this Random rng, IReadOnlyList<T> items) => items[rng.Next(items.Count)];

    /// <summary>A whole number in <c>[min, max]</c>.</summary>
    internal static int Between(this Random rng, int min, int max) => rng.Next(min, max + 1);

    /// <summary>True with the given probability.</summary>
    internal static bool Chance(this Random rng, double probability) => rng.NextDouble() < probability;

    /// <summary>A money amount in <c>[min, max]</c>, biased towards smaller amounts, with cents (none for JPY).</summary>
    internal static decimal Amount(this Random rng, decimal min, decimal max, Currency currency)
    {
        var skew = (decimal)Math.Pow(rng.NextDouble(), 2.2);
        return decimal.Round(min + (max - min) * skew, EndpointSupport.Decimals(currency));
    }

    /// <summary>A stable GUID drawn from the generator, so ids are the same on every run.</summary>
    internal static Guid NextGuid(this Random rng)
    {
        var bytes = new byte[16];
        rng.NextBytes(bytes);
        bytes[7] = (byte)(bytes[7] & 0x0F | 0x40);
        bytes[8] = (byte)(bytes[8] & 0x3F | 0x80);
        return new Guid(bytes);
    }

    /// <summary>A string of random decimal digits.</summary>
    internal static string Digits(this Random rng, int length) => string.Concat(Enumerable.Range(0, length).Select(_ => (char)('0' + rng.Next(10))));

    /// <summary>The nearest business day on or after a date.</summary>
    internal static DateOnly BusinessDay(DateOnly date) => date.DayOfWeek switch
    {
        DayOfWeek.Saturday => date.AddDays(2),
        DayOfWeek.Sunday => date.AddDays(1),
        _ => date
    };

    /// <summary>The nearest business day on or before a date.</summary>
    internal static DateOnly PreviousBusinessDay(DateOnly date) => date.DayOfWeek switch
    {
        DayOfWeek.Saturday => date.AddDays(-1),
        DayOfWeek.Sunday => date.AddDays(-2),
        _ => date
    };
}
