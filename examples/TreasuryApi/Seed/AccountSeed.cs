namespace TreasuryApi;

/// <summary>Seeds Acme's bank accounts with checksum-valid IBANs, real-format BICs and cent-accurate balances.</summary>
internal static class AccountSeed
{
    /// <summary>How a bank builds the account part (BBAN) of its IBANs.</summary>
    /// <param name="Name">The bank's name.</param>
    /// <param name="Bic">The bank's BIC.</param>
    /// <param name="Country">The ISO 3166-1 alpha-2 country the IBAN belongs to.</param>
    /// <param name="BankCode">The bank/branch identifier that starts the BBAN.</param>
    internal sealed record Bank(string Name, string Bic, string Country, string BankCode);

    /// <summary>The BBAN length of the countries used here, so that IBANs come out at the correct length.</summary>
    internal static readonly Dictionary<string, int> BbanLength = new()
    {
        ["AT"] = 16, ["BE"] = 12, ["CH"] = 17, ["DE"] = 18, ["DK"] = 14, ["EE"] = 16, ["ES"] = 20, ["FR"] = 23,
        ["GB"] = 18, ["IE"] = 18, ["IT"] = 23, ["NL"] = 14, ["NO"] = 11, ["PL"] = 24, ["SE"] = 20
    };

    internal static readonly Bank Aib = new("AIB", "AIBKIE2D", "IE", "AIBK");
    internal static readonly Bank DeutscheBank = new("Deutsche Bank", "DEUTDEFF", "DE", "50070010");
    internal static readonly Bank Commerzbank = new("Commerzbank", "COBADEFF", "DE", "50040000");
    internal static readonly Bank JpMorgan = new("J.P. Morgan SE", "CHASDEFX", "DE", "50110800");
    internal static readonly Bank Barclays = new("Barclays", "BARCGB22", "GB", "BARC");
    internal static readonly Bank Hsbc = new("HSBC", "MIDLGB22", "GB", "MIDL");
    internal static readonly Bank BnpParibas = new("BNP Paribas", "BNPAFRPP", "FR", "30004");
    internal static readonly Bank Ing = new("ING", "INGBNL2A", "NL", "INGB");
    internal static readonly Bank Ubs = new("UBS", "UBSWCHZH80A", "CH", "00206");
    internal static readonly Bank Seb = new("SEB", "ESSESESS", "SE", "500");

    private sealed record Spec(string Name, string Entity, string EntityCountry, Bank Bank, Currency Currency, AccountType Type,
        decimal Balance, string? Note = null, AccountStatus Status = AccountStatus.Open);

    /// <summary>The fixed list of accounts. Balances are a rough size; the seed adds cents.</summary>
    private static readonly Spec[] Specs =
    [
        new("Operating EUR", "Acme Holdings Ltd", "IE", Aib, Currency.EUR, AccountType.Operating, 250000m, "Main euro operating account for the group."),
        new("Operating USD", "Acme Holdings Ltd", "IE", Aib, Currency.USD, AccountType.Operating, 100000m, "Dollar operating account held in Dublin."),
        new("Dublin Collections EUR", "Acme Holdings Ltd", "IE", Aib, Currency.EUR, AccountType.Collections, 1_284_000m, "Receives customer payments."),
        new("Dublin Savings EUR", "Acme Holdings Ltd", "IE", Aib, Currency.EUR, AccountType.Savings, 3_500_000m, "Surplus cash, 30-day notice."),
        new("Dublin Payroll EUR", "Acme Holdings Ltd", "IE", Aib, Currency.EUR, AccountType.Payroll, 412_000m, "Funds the monthly Irish payroll."),
        new("Frankfurt Operating EUR", "Acme GmbH", "DE", DeutscheBank, Currency.EUR, AccountType.Operating, 640_000m),
        new("Frankfurt Payroll EUR", "Acme GmbH", "DE", Commerzbank, Currency.EUR, AccountType.Payroll, 385_000m),
        new("Frankfurt Collections EUR", "Acme GmbH", "DE", DeutscheBank, Currency.EUR, AccountType.Collections, 920_000m),
        new("Frankfurt Escrow EUR", "Acme GmbH", "DE", Commerzbank, Currency.EUR, AccountType.Escrow, 500_000m, "Held for the Rhein Chemie supply agreement."),
        new("New York Operating USD", "Acme Inc", "US", JpMorgan, Currency.USD, AccountType.Operating, 870_000m, "Dollar operating account of the US entity."),
        new("New York Payroll USD", "Acme Inc", "US", JpMorgan, Currency.USD, AccountType.Payroll, 540_000m),
        new("New York Collections USD", "Acme Inc", "US", JpMorgan, Currency.USD, AccountType.Collections, 1_750_000m),
        new("New York Savings USD", "Acme Inc", "US", JpMorgan, Currency.USD, AccountType.Savings, 4_200_000m),
        new("London Operating GBP", "Acme UK Ltd", "GB", Barclays, Currency.GBP, AccountType.Operating, 510_000m),
        new("London Payroll GBP", "Acme UK Ltd", "GB", Hsbc, Currency.GBP, AccountType.Payroll, 295_000m, "Frozen by the bank during a KYC refresh.", AccountStatus.Frozen),
        new("London Collections GBP", "Acme UK Ltd", "GB", Barclays, Currency.GBP, AccountType.Collections, 760_000m),
        new("London Operating EUR", "Acme UK Ltd", "GB", Hsbc, Currency.EUR, AccountType.Operating, 180_000m, "Euro account for UK euro suppliers."),
        new("Paris Operating EUR", "Acme SAS", "FR", BnpParibas, Currency.EUR, AccountType.Operating, 430_000m),
        new("Paris Collections EUR", "Acme SAS", "FR", BnpParibas, Currency.EUR, AccountType.Collections, 0m, "Closed after the move to the Dublin collections account.", AccountStatus.Closed),
        new("Paris Payroll EUR", "Acme SAS", "FR", BnpParibas, Currency.EUR, AccountType.Payroll, 265_000m),
        new("Amsterdam Operating EUR", "Acme BV", "NL", Ing, Currency.EUR, AccountType.Operating, 355_000m),
        new("Amsterdam Collections EUR", "Acme BV", "NL", Ing, Currency.EUR, AccountType.Collections, 610_000m),
        new("Amsterdam Savings EUR", "Acme BV", "NL", Ing, Currency.EUR, AccountType.Savings, 2_100_000m),
        new("Zurich Operating CHF", "Acme AG", "CH", Ubs, Currency.CHF, AccountType.Operating, 395_000m),
        new("Stockholm Operating SEK", "Acme AB", "SE", Seb, Currency.SEK, AccountType.Operating, 4_300_000m),
        new("Stockholm Payroll SEK", "Acme AB", "SE", Seb, Currency.SEK, AccountType.Payroll, 2_450_000m),
        new("Tokyo Operating JPY", "Acme KK", "JP", JpMorgan, Currency.JPY, AccountType.Operating, 96_000_000m, "Yen operating account held with the treasury centre bank.")
    ];

    /// <summary>Builds the accounts. Their available balance equals the ledger until payments reserve funds.</summary>
    internal static List<AccountRecord> Create(Random rng, DateOnly today)
    {
        var accounts = new List<AccountRecord>();
        foreach (var spec in Specs)
        {
            var isOperatingEur = spec.Name == "Operating EUR";
            var isOperatingUsd = spec.Name == "Operating USD";
            var id = isOperatingEur ? Guid.Parse(DemoData.OperatingEurId) : isOperatingUsd ? Guid.Parse(DemoData.OperatingUsdId) : rng.NextGuid();
            var decimals = EndpointSupport.Decimals(spec.Currency);
            // The two original demo accounts keep their exact balances; the others get believable cents.
            var ledger = isOperatingEur || isOperatingUsd || spec.Balance == 0m
                ? spec.Balance
                : decimal.Round(spec.Balance * (decimal)(0.85 + rng.NextDouble() * 0.3), decimals);
            var closed = spec.Status == AccountStatus.Closed;
            var account = new AccountRecord
            {
                Id = id, Name = spec.Name, Entity = spec.Entity, EntityCountry = spec.EntityCountry, BankName = spec.Bank.Name,
                Bic = spec.Bank.Bic, Iban = IbanTools.Format(NewIban(rng, spec.Bank)), Currency = spec.Currency, Type = spec.Type,
                Status = spec.Status, LedgerBalance = ledger, AvailableBalance = ledger,
                OpenedOn = today.AddDays(-rng.Between(400, 2600)), ClosedOn = closed ? today.AddDays(-rng.Between(30, 120)) : null,
                Description = spec.Note
            };
            if (isOperatingEur) account.Iban = "IE29 AIBK 9311 5212 3456 78";
            accounts.Add(account);
        }
        return accounts;
    }

    /// <summary>
    /// Lowers each account's available balance by what active payments reserve and records the intraday history
    /// that ends at that final figure. Called after payments exist.
    /// </summary>
    internal static List<BalanceSnapshotRecord> ApplyReservations(Random rng, DateTimeOffset now, List<AccountRecord> accounts,
        IReadOnlyDictionary<Guid, decimal> reserved)
    {
        var snapshots = new List<BalanceSnapshotRecord>();
        foreach (var account in accounts)
        {
            account.AvailableBalance = account.LedgerBalance - reserved.GetValueOrDefault(account.Id);
            if (account.Status == AccountStatus.Closed) continue;
            var decimals = EndpointSupport.Decimals(account.Currency);
            var held = account.LedgerBalance - account.AvailableBalance;
            for (var i = 0; i < 8; i++)
            {
                var back = 7 - i;
                // Earlier points drift by a few tenths of a percent; the last point is the real balance.
                var drift = back == 0 ? 0m : decimal.Round(account.LedgerBalance * (decimal)((rng.NextDouble() - 0.5) * 0.01), decimals);
                var ledger = account.LedgerBalance + drift;
                snapshots.Add(new BalanceSnapshotRecord
                {
                    Id = rng.NextGuid(), AccountId = account.Id, AsOf = now.AddHours(-3 * back).AddMinutes(-rng.Between(0, 5)),
                    Ledger = ledger, Available = ledger - held
                });
            }
        }
        return snapshots;
    }

    /// <summary>Builds a checksum-valid IBAN for a bank with random account digits.</summary>
    internal static string NewIban(Random rng, Bank bank)
    {
        var length = BbanLength[bank.Country];
        var bban = bank.BankCode + rng.Digits(length - bank.BankCode.Length);
        return IbanTools.Build(bank.Country, bban);
    }
}
