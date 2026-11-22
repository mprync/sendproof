using Microsoft.AspNetCore.Identity;

namespace StoreApi;

/// <summary>
/// Seeds a newly created database with a believable, deterministic online-store data set: staff and customers, a
/// catalogue of outdoor gear with prices in eight currencies, stock, coupons, and about 160 orders in every status with
/// their payments, refunds, shipments and stock movements.
/// </summary>
/// <remarks>
/// The same random seed is used on every run, so ids, names and amounts are identical between databases; only dates
/// move, because they are relative to the day the database is created. The named records below always exist with the
/// values the examples and tests rely on: <c>NPK-JKT-BLK-M</c> starts with exactly 40 units on hand and none reserved,
/// and <c>Mia Customer</c> has no cart.
/// </remarks>
internal static class DemoData
{
    /// <summary>The password of every seeded user.</summary>
    internal const string Password = "Demo123!";
    /// <summary>The ID of the <c>Mia Customer</c> profile.</summary>
    internal const string MiaId = "c0a10000-0000-4000-8000-000000000001";
    /// <summary>The ID of the <c>Noah Customer</c> profile.</summary>
    internal const string NoahId = "c0a10000-0000-4000-8000-000000000002";
    /// <summary>The ID of the <c>Liam Reseller</c> profile, whose hourly order limit is used up in Redis.</summary>
    internal const string LiamId = "c0a10000-0000-4000-8000-000000000004";
    /// <summary>The ID of the <c>Northpeak Storm Shell Jacket</c> product.</summary>
    internal const string JacketId = "9a100000-0000-4000-8000-000000000001";
    /// <summary>The SKU of the black, medium jacket, which starts with 40 units on hand.</summary>
    internal const string JacketSku = "NPK-JKT-BLK-M";
    /// <summary>The ID of the <c>Jackets</c> category.</summary>
    internal const string JacketsCategoryId = "ca7e0000-0000-4000-8000-000000000001";

    private const int RandomSeed = 20260101;

    /// <summary>Creates the schema and fills it. Only a newly created database file is ever passed in.</summary>
    internal static async Task SeedAsync(IServiceProvider services)
    {
        var db = services.GetRequiredService<StoreDbContext>();
        // Only a newly created file is initialized; never seed an existing database.
        await db.Database.EnsureCreatedAsync();
        var hasher = services.GetRequiredService<IPasswordHasher<DemoUser>>();
        var rng = new Random(RandomSeed);
        var now = DateTimeOffset.UtcNow;

        var people = CustomerSeed.Create(rng, now, hasher);
        db.Users.AddRange(people.Users);
        db.Customers.AddRange(people.Customers);
        db.Addresses.AddRange(people.Addresses);
        var catalogue = CatalogSeed.Create(rng, now);
        db.Categories.AddRange(catalogue.Categories);
        db.Products.AddRange(catalogue.Products);
        db.Variants.AddRange(catalogue.Variants);
        db.Prices.AddRange(catalogue.Prices);
        var coupons = OrderSeed.Coupons(now);
        db.Coupons.AddRange(coupons);
        await db.SaveChangesAsync();

        // The seed counts redemptions on these same instances, which are tracked, so the final counts are saved with the orders.
        var orders = OrderSeed.Create(rng, now, people, catalogue, coupons);
        db.Orders.AddRange(orders.Orders);
        db.OrderLines.AddRange(orders.Lines);
        db.Payments.AddRange(orders.Payments);
        db.Refunds.AddRange(orders.Refunds);
        db.Shipments.AddRange(orders.Shipments);
        db.Stock.AddRange(orders.Stock);
        db.StockMovements.AddRange(orders.Movements);
        db.Reservations.AddRange(orders.Reservations);
        db.Carts.AddRange(orders.Carts);
        db.CartItems.AddRange(orders.CartItems);
        db.AuditEvents.AddRange(orders.Audit);
        await db.SaveChangesAsync();
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

    /// <summary>A string of random upper-case hexadecimal digits.</summary>
    internal static string Hex(this Random rng, int length) => string.Concat(Enumerable.Range(0, length).Select(_ => "0123456789ABCDEF"[rng.Next(16)]));
}
