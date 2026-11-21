namespace TreasuryApi;

/// <summary>Seeds suppliers, customers, group companies and tax authorities with realistic names, addresses and bank details.</summary>
internal static class CounterpartySeed
{
    /// <summary>The routing numbers of large US banks (all pass the ABA checksum) used for ACH counterparties.</summary>
    private static readonly string[] UsRouting = ["021000021", "026009593", "121000248", "021000089", "322271627"];
    private static readonly string[] UsBanks = ["JPMorgan Chase", "Bank of America", "Wells Fargo", "Citibank", "JPMorgan Chase (West)"];

    /// <summary>Banks counterparties use, by country, with their BIC and the BBAN prefix that starts their IBANs.</summary>
    private static readonly Dictionary<string, AccountSeed.Bank[]> BanksByCountry = new()
    {
        ["DE"] = [AccountSeed.DeutscheBank, AccountSeed.Commerzbank, new("Hamburger Sparkasse", "HASPDEHH", "DE", "20050550"), new("HypoVereinsbank", "HYVEDEMM", "DE", "70020270")],
        ["NL"] = [AccountSeed.Ing, new("ABN AMRO", "ABNANL2A", "NL", "ABNA"), new("Rabobank", "RABONL2U", "NL", "RABO")],
        ["FR"] = [AccountSeed.BnpParibas, new("Crédit Agricole", "AGRIFRPP", "FR", "18206"), new("Société Générale", "SOGEFRPP", "FR", "30003")],
        ["SE"] = [AccountSeed.Seb, new("Swedbank", "SWEDSESS", "SE", "800"), new("Nordea", "NDEASESS", "SE", "300")],
        ["NO"] = [new("DNB", "DNBANOKK", "NO", "1503")],
        ["CH"] = [AccountSeed.Ubs, new("Credit Suisse", "CRESCHZZ80A", "CH", "04835")],
        ["IE"] = [AccountSeed.Aib, new("Bank of Ireland", "BOFIIE2D", "IE", "BOFI"), new("Permanent TSB", "IPBSIE2D", "IE", "IPBS")],
        ["GB"] = [AccountSeed.Barclays, AccountSeed.Hsbc, new("NatWest", "NWBKGB2L", "GB", "NWBK"), new("Lloyds Bank", "LOYDGB2L", "GB", "LOYD")],
        ["ES"] = [new("Banco Santander", "BSCHESMM", "ES", "0049"), new("BBVA", "BBVAESMM", "ES", "0182"), new("CaixaBank", "CAIXESBB", "ES", "2100")],
        ["IT"] = [new("UniCredit", "UNCRITMM", "IT", "X02008"), new("Intesa Sanpaolo", "BCITITMM", "IT", "X03069")],
        ["PL"] = [new("PKO Bank Polski", "BPKOPLPW", "PL", "10201026")],
        ["DK"] = [new("Danske Bank", "DABADKKK", "DK", "3000")],
        ["AT"] = [new("Erste Bank", "GIBAATWW", "AT", "20111")],
        ["BE"] = [new("KBC Bank", "KREDBEBB", "BE", "737")],
        ["EE"] = [new("Swedbank Estonia", "HABAEE2X", "EE", "22")]
    };

    private static readonly Dictionary<string, string[]> Cities = new()
    {
        ["DE"] = ["Hamburg", "Frankfurt am Main", "Munich", "Düsseldorf", "Stuttgart", "Cologne"],
        ["NL"] = ["Rotterdam", "Amsterdam", "Utrecht", "Eindhoven"],
        ["FR"] = ["Lyon", "Paris", "Lille", "Bordeaux"],
        ["SE"] = ["Gothenburg", "Stockholm", "Malmö"],
        ["NO"] = ["Bergen", "Oslo", "Stavanger"],
        ["CH"] = ["Zurich", "Basel", "Lucerne"],
        ["IE"] = ["Dublin", "Cork", "Galway", "Limerick"],
        ["GB"] = ["London", "Manchester", "Sheffield", "Bristol"],
        ["ES"] = ["Madrid", "Barcelona", "Valencia"],
        ["IT"] = ["Milan", "Turin", "Bologna"],
        ["PL"] = ["Warsaw", "Kraków", "Gdańsk"],
        ["DK"] = ["Copenhagen", "Aarhus"],
        ["AT"] = ["Vienna", "Graz"],
        ["BE"] = ["Brussels", "Antwerp"],
        ["EE"] = ["Tallinn", "Tartu"],
        ["US"] = ["Chicago", "Seattle", "Atlanta", "Denver", "Boston"],
        ["CA"] = ["Toronto", "Vancouver", "Montreal"],
        ["SG"] = ["Singapore"],
        ["CN"] = ["Shenzhen", "Shanghai"],
        ["JP"] = ["Kyoto", "Osaka", "Tokyo"],
        ["IN"] = ["Mumbai", "Bengaluru", "Pune"]
    };

    /// <summary>Banks of the countries that are paid by SWIFT: BIC and name.</summary>
    private static readonly Dictionary<string, (string Bic, string Name)> SwiftBanks = new()
    {
        ["SG"] = ("DBSSSGSG", "DBS Bank"), ["CN"] = ("BKCHCNBJ", "Bank of China"), ["JP"] = ("MHCBJPJT", "Mizuho Bank"),
        ["IN"] = ("HDFCINBB", "HDFC Bank"), ["CA"] = ("ROYCCAT2", "Royal Bank of Canada")
    };

    private static readonly string[] Streets = ["Hauptstraße", "Industrieweg", "Harbour Road", "Station Street", "Rue de la Paix", "Kungsgatan", "Main Street",
        "Park Avenue", "Canal Quay", "Gewerbepark", "Bahnhofstrasse", "Via Roma", "Calle Mayor", "Queen Street", "Mill Lane"];

    private sealed record Spec(string Name, CounterpartyType Type, string Country, string Scheme = "Iban");

    private static readonly Spec[] Specs =
    [
        // Suppliers
        new("Northwind Logistics GmbH", CounterpartyType.Supplier, "DE"),
        new("Bergmann Industrietechnik AG", CounterpartyType.Supplier, "DE"),
        new("Kessler Verpackungen GmbH", CounterpartyType.Supplier, "DE"),
        new("Atlas Freight Forwarding BV", CounterpartyType.Supplier, "NL"),
        new("Rotterdam Marine Supplies BV", CounterpartyType.Supplier, "NL"),
        new("Lumière Packaging SAS", CounterpartyType.Supplier, "FR"),
        new("Ateliers Marchand SAS", CounterpartyType.Supplier, "FR"),
        new("Nordic Components AB", CounterpartyType.Supplier, "SE"),
        new("Fjordline Maritime AS", CounterpartyType.Supplier, "NO"),
        new("Helvetia Precision AG", CounterpartyType.Supplier, "CH"),
        new("Dublin Office Solutions Ltd", CounterpartyType.Supplier, "IE"),
        new("Emerald Catering Services Ltd", CounterpartyType.Supplier, "IE"),
        new("Brightwave Telecom plc", CounterpartyType.Supplier, "GB"),
        new("Thames Cloud Hosting Ltd", CounterpartyType.Supplier, "GB"),
        new("Pennine Steel Ltd", CounterpartyType.Supplier, "GB"),
        new("Madrid Equipos Industriales SL", CounterpartyType.Supplier, "ES"),
        new("Lombardi Tessuti SpA", CounterpartyType.Supplier, "IT"),
        new("Warsaw Software Sp. z o.o.", CounterpartyType.Supplier, "PL"),
        new("Copenhagen Cleantech A/S", CounterpartyType.Supplier, "DK"),
        new("Vienna Consulting GmbH", CounterpartyType.Supplier, "AT"),
        new("Brussels Legal Partners BV", CounterpartyType.Supplier, "BE"),
        new("Lakeside Facilities Inc", CounterpartyType.Supplier, "US", "UsAch"),
        new("Cascade Industrial Supply Inc", CounterpartyType.Supplier, "US", "UsAch"),
        new("Pacific Components Pte Ltd", CounterpartyType.Supplier, "SG", "Swift"),
        new("Shenzhen Electronics Co Ltd", CounterpartyType.Supplier, "CN", "Swift"),
        new("Kyoto Precision KK", CounterpartyType.Supplier, "JP", "Swift"),
        new("Mumbai IT Services Pvt Ltd", CounterpartyType.Supplier, "IN", "Swift"),
        new("Toronto Freight Corp", CounterpartyType.Supplier, "CA", "Swift"),
        // Customers
        new("Meridian Retail Group plc", CounterpartyType.Customer, "GB"),
        new("Alpenhof Hotels AG", CounterpartyType.Customer, "CH"),
        new("Vega Supermercados SA", CounterpartyType.Customer, "ES"),
        new("Orion Healthcare Ltd", CounterpartyType.Customer, "IE"),
        new("Baltic Trading OÜ", CounterpartyType.Customer, "EE"),
        new("Sunrise Wholesale Inc", CounterpartyType.Customer, "US", "UsAch"),
        new("Maple Leaf Distribution Inc", CounterpartyType.Customer, "CA", "Swift"),
        new("Nakamura Trading Co Ltd", CounterpartyType.Customer, "JP", "Swift"),
        new("Rhein Chemie GmbH", CounterpartyType.Customer, "DE"),
        new("Hollandia Foods BV", CounterpartyType.Customer, "NL"),
        // Group companies
        new("Acme GmbH", CounterpartyType.Intercompany, "DE"),
        new("Acme Inc", CounterpartyType.Intercompany, "US", "UsAch"),
        new("Acme UK Ltd", CounterpartyType.Intercompany, "GB"),
        new("Acme SAS", CounterpartyType.Intercompany, "FR"),
        new("Acme BV", CounterpartyType.Intercompany, "NL"),
        new("Acme AB", CounterpartyType.Intercompany, "SE"),
        // Tax authorities
        new("Irish Revenue Commissioners", CounterpartyType.TaxAuthority, "IE"),
        new("HM Revenue & Customs", CounterpartyType.TaxAuthority, "GB"),
        new("Bundeszentralamt für Steuern", CounterpartyType.TaxAuthority, "DE"),
        new("Direction Générale des Finances Publiques", CounterpartyType.TaxAuthority, "FR"),
        new("Belastingdienst", CounterpartyType.TaxAuthority, "NL"),
        new("Skatteverket", CounterpartyType.TaxAuthority, "SE"),
        new("Internal Revenue Service", CounterpartyType.TaxAuthority, "US", "UsAch")
    ];

    /// <summary>Builds the counterparties. A few are archived to show the archived status.</summary>
    internal static List<CounterpartyRecord> Create(Random rng, DateTimeOffset now, IReadOnlyList<AccountRecord> accounts)
    {
        var result = new List<CounterpartyRecord>();
        foreach (var spec in Specs)
        {
            var isNorthwind = spec.Name == "Northwind Logistics GmbH";
            var cities = Cities[spec.Country];
            var counterparty = new CounterpartyRecord
            {
                Id = isNorthwind ? Guid.Parse(DemoData.NorthwindId) : rng.NextGuid(), Name = spec.Name, Type = spec.Type,
                Status = CounterpartyStatus.Active, Country = spec.Country,
                AddressLine = $"{rng.Between(1, 180)} {rng.Pick(Streets)}", City = rng.Pick(cities),
                PostalCode = rng.Digits(5), ContactEmail = $"payables@{Slug(spec.Name)}.example",
                CreatedAt = now.AddDays(-rng.Between(60, 900)).AddMinutes(-rng.Between(0, 1400))
            };
            switch (spec.Scheme)
            {
                case "UsAch":
                    var routingIndex = rng.Next(UsRouting.Length);
                    counterparty.BankScheme = BankScheme.UsAch;
                    counterparty.RoutingNumber = UsRouting[routingIndex];
                    counterparty.BankName = UsBanks[routingIndex];
                    counterparty.AccountNumber = rng.Digits(10);
                    break;
                case "Swift":
                    counterparty.BankScheme = BankScheme.Swift;
                    var (bic, bank) = SwiftBanks[spec.Country];
                    counterparty.Bic = bic; counterparty.BankName = bank; counterparty.AccountNumber = rng.Digits(12);
                    break;
                default:
                    var bankChoice = rng.Pick(BanksByCountry[spec.Country]);
                    counterparty.BankScheme = BankScheme.Iban;
                    counterparty.Iban = IbanTools.Format(AccountSeed.NewIban(rng, bankChoice));
                    counterparty.Bic = bankChoice.Bic;
                    counterparty.BankName = bankChoice.Name;
                    break;
            }
            if (isNorthwind)
            {
                counterparty.Iban = "DE89 3704 0044 0532 0130 00"; counterparty.Bic = "COBADEFF"; counterparty.BankName = "Commerzbank";
            }
            if (spec.Type == CounterpartyType.Intercompany)
            {
                // A group company is paid into its own operating account.
                var own = accounts.FirstOrDefault(a => a.Entity == spec.Name && a.Type == AccountType.Operating && a.Status == AccountStatus.Open);
                if (own is not null)
                {
                    counterparty.BankScheme = BankScheme.Iban; counterparty.Iban = own.Iban; counterparty.Bic = own.Bic; counterparty.BankName = own.BankName;
                    counterparty.RoutingNumber = counterparty.AccountNumber = null;
                }
            }
            result.Add(counterparty);
        }
        // Two suppliers that Acme stopped using.
        foreach (var name in new[] { "Pennine Steel Ltd", "Kessler Verpackungen GmbH" })
            result.Single(c => c.Name == name).Status = CounterpartyStatus.Archived;
        return result;
    }

    private static string Slug(string name)
    {
        var letters = new string(name.ToLowerInvariant().Select(c => char.IsAsciiLetterOrDigit(c) ? c : '-').ToArray());
        return string.Join('-', letters.Split('-', StringSplitOptions.RemoveEmptyEntries).Take(2));
    }
}
