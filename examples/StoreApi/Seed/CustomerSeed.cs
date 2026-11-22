using Microsoft.AspNetCore.Identity;

namespace StoreApi;

/// <summary>The seeded people: users who can sign in, customer profiles and their saved addresses.</summary>
/// <param name="Users">Staff and the customers who have a sign-in.</param>
/// <param name="Customers">Every customer profile.</param>
/// <param name="Addresses">Every saved address.</param>
internal sealed record People(IReadOnlyList<DemoUser> Users, IReadOnlyList<CustomerRecord> Customers, IReadOnlyList<AddressRecord> Addresses);

/// <summary>Seeds the staff, the customers and their addresses.</summary>
internal static class CustomerSeed
{
    private sealed record Place(string City, string? Region, string Country, string Postal, string Street, Currency Currency, string Phone);

    private static readonly Place[] Places =
    [
        new("Dublin", "Co. Dublin", "IE", "D02 X285", "14 Harcourt Street", Currency.EUR, "+353 87 412 9083"),
        new("Cork", "Co. Cork", "IE", "T12 R2PK", "9 Oliver Plunkett Street", Currency.EUR, "+353 86 220 1744"),
        new("Berlin", null, "DE", "10115", "Torstraße 112", Currency.EUR, "+49 30 2345 6789"),
        new("Hamburg", null, "DE", "20457", "Speicherstadt 6", Currency.EUR, "+49 40 3344 5566"),
        new("Amsterdam", null, "NL", "1015 CS", "Keizersgracht 241", Currency.EUR, "+31 20 555 0143"),
        new("Lyon", null, "FR", "69002", "27 Rue de la République", Currency.EUR, "+33 4 72 00 11 22"),
        new("London", null, "GB", "E2 8DY", "58 Columbia Road", Currency.GBP, "+44 20 7946 0321"),
        new("Manchester", null, "GB", "M4 1HN", "12 Oldham Street", Currency.GBP, "+44 161 496 0742"),
        new("Portland", "OR", "US", "97209", "1420 NW Lovejoy Street", Currency.USD, "+1 503 555 0147"),
        new("Denver", "CO", "US", "80202", "1801 Wynkoop Street", Currency.USD, "+1 303 555 0188"),
        new("Austin", "TX", "US", "78701", "600 Congress Avenue", Currency.USD, "+1 512 555 0126"),
        new("Boston", "MA", "US", "02110", "100 Federal Street", Currency.USD, "+1 617 555 0109"),
        new("Toronto", "ON", "CA", "M5V 2T6", "88 Queen Street West", Currency.CAD, "+1 416 555 0170"),
        new("Vancouver", "BC", "CA", "V6B 1A9", "401 West Georgia Street", Currency.CAD, "+1 604 555 0165"),
        new("Melbourne", "VIC", "AU", "3000", "120 Collins Street", Currency.AUD, "+61 3 5550 0133"),
        new("Sydney", "NSW", "AU", "2000", "1 Martin Place", Currency.AUD, "+61 2 5550 0192"),
        new("Stockholm", null, "SE", "111 29", "Drottninggatan 55", Currency.SEK, "+46 8 555 010 12"),
        new("Zürich", "ZH", "CH", "8001", "Bahnhofstrasse 21", Currency.CHF, "+41 44 555 01 23"),
        new("Osaka", null, "JP", "530-0001", "2-4-9 Umeda, Kita-ku", Currency.JPY, "+81 6 5550 0144")
    ];

    private static readonly string[] FirstNames =
    [
        "Aoife", "Conor", "Siobhán", "Declan", "Katja", "Jonas", "Femke", "Daan", "Camille", "Théo", "Imogen", "Harry", "Zoe", "Oliver", "Emma", "Jack",
        "Sofia", "Lucas", "Hannah", "Ethan", "Chloe", "Liam", "Nora", "Elias", "Maya", "Kenji", "Yuki", "Freja", "Anders", "Lea"
    ];

    private static readonly string[] LastNames =
    [
        "Brennan", "Walsh", "Kavanagh", "Doyle", "Schneider", "Becker", "de Vries", "Jansen", "Moreau", "Laurent", "Whitfield", "Patel", "Okafor",
        "Hughes", "Nguyen", "Carter", "Reyes", "Tanaka", "Sato", "Lindqvist", "Berg", "Keller", "MacLeod", "O'Connor", "Fischer", "Rossi", "Silva", "Novak"
    ];

    /// <summary>Creates the staff, the five named customer sign-ins, and about two dozen more customers.</summary>
    internal static People Create(Random rng, DateTimeOffset now, IPasswordHasher<DemoUser> hasher)
    {
        var users = new List<DemoUser>();
        void User(string email, string name, string role, string? title, bool active = true)
        {
            var user = new DemoUser { Email = email, Name = name, Role = role, JobTitle = title, IsActive = active, PasswordHash = "" };
            user.PasswordHash = hasher.HashPassword(user, DemoData.Password);
            users.Add(user);
        }
        User("ada.admin@acme.dev", "Ada Admin", "admin", "Head of E-commerce");
        User("sam.support@acme.dev", "Sam Support", "support", "Customer Support Lead");
        User("pia.support@acme.dev", "Pia Support", "support", "Support Agent");
        User("wes.warehouse@acme.dev", "Wes Warehouse", "warehouse", "Warehouse Supervisor");
        User("gus.former@acme.dev", "Gus Former", "support", "Former Support Agent", active: false);

        var customers = new List<CustomerRecord>();
        var addresses = new List<AddressRecord>();
        void Customer(Guid id, string first, string last, string email, Place place, CustomerTier tier, int daysAgo, bool signIn, bool optIn)
        {
            customers.Add(new CustomerRecord
            {
                Id = id, Email = email, FirstName = first, LastName = last, Phone = place.Phone, PreferredCurrency = place.Currency, Tier = tier,
                MarketingOptIn = optIn, CreatedAt = now.AddDays(-daysAgo).AddHours(-rng.Between(0, 20))
            });
            if (signIn) User(email, $"{first} {last}", "customer", null);
            addresses.Add(new AddressRecord
            {
                Id = rng.NextGuid(), CustomerId = id, Kind = AddressKind.Shipping, Label = "Home", Recipient = $"{first} {last}", Line1 = place.Street,
                City = place.City, Region = place.Region, PostalCode = place.Postal, Country = place.Country, IsDefault = true
            });
            if (rng.Chance(0.4))
                addresses.Add(new AddressRecord
                {
                    Id = rng.NextGuid(), CustomerId = id, Kind = AddressKind.Billing, Label = "Billing", Recipient = $"{first} {last}", Line1 = place.Street,
                    Line2 = rng.Chance(0.3) ? "Flat 3" : null, City = place.City, Region = place.Region, PostalCode = place.Postal, Country = place.Country, IsDefault = true
                });
            if (rng.Chance(0.25))
            {
                var other = rng.Pick(Places);
                addresses.Add(new AddressRecord
                {
                    Id = rng.NextGuid(), CustomerId = id, Kind = AddressKind.Shipping, Label = "Office", Recipient = $"{first} {last}", Line1 = other.Street,
                    Line2 = "Reception", City = other.City, Region = other.Region, PostalCode = other.Postal, Country = other.Country
                });
            }
        }
        Customer(Guid.Parse(DemoData.MiaId), "Mia", "Customer", "mia.customer@acme.dev", Places[0], CustomerTier.Plus, 410, true, true);
        Customer(Guid.Parse(DemoData.NoahId), "Noah", "Customer", "noah.customer@acme.dev", Places[8], CustomerTier.Standard, 260, true, false);
        Customer(Guid.Parse("c0a10000-0000-4000-8000-000000000003"), "Priya", "Customer", "priya.customer@acme.dev", Places[6], CustomerTier.Vip, 690, true, true);
        Customer(Guid.Parse(DemoData.LiamId), "Liam", "Reseller", "liam.reseller@acme.dev", Places[9], CustomerTier.Standard, 120, true, false);
        Customer(Guid.Parse("c0a10000-0000-4000-8000-000000000005"), "Lena", "Customer", "lena.customer@acme.dev", Places[2], CustomerTier.Plus, 330, true, true);
        Customer(Guid.Parse("c0a10000-0000-4000-8000-000000000006"), "Omar", "Customer", "omar.customer@acme.dev", Places[12], CustomerTier.Standard, 90, true, true);

        var taken = new HashSet<string>(customers.Select(c => c.Email));
        for (var i = 0; i < 26; i++)
        {
            var first = rng.Pick(FirstNames);
            var last = rng.Pick(LastNames);
            var email = $"{Ascii(first)}.{Ascii(last)}{(i % 3 == 0 ? rng.Between(2, 99).ToString() : "")}@{rng.Pick(new[] { "example.com", "mail.example", "post.example" })}".ToLowerInvariant();
            if (!taken.Add(email)) continue;
            var tier = rng.Chance(0.15) ? CustomerTier.Vip : rng.Chance(0.3) ? CustomerTier.Plus : CustomerTier.Standard;
            Customer(rng.NextGuid(), first, last, email, rng.Pick(Places), tier, rng.Between(5, 700), false, rng.Chance(0.55));
        }
        return new People(users, customers, addresses);
    }

    /// <summary>Lower-cases a name and folds the accents and apostrophes an email address cannot hold.</summary>
    private static string Ascii(string text) => text.ToLowerInvariant()
        .Replace("á", "a").Replace("é", "e").Replace("í", "i").Replace("ó", "o").Replace("ú", "u").Replace("ü", "u").Replace("ö", "o").Replace("ä", "a")
        .Replace("è", "e").Replace("ç", "c").Replace("ã", "a").Replace("å", "a").Replace("'", "").Replace(" ", "").Replace("ß", "ss");
}
