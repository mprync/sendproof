namespace TreasuryApi;

/// <summary>
/// Seeds daily bank statements (camt.053 style) for the main accounts over the last two weeks. Balances reconcile:
/// each day's opening balance equals the previous day's closing balance, and the latest closing balance equals the
/// account's current ledger balance.
/// </summary>
internal static class StatementSeed
{
    private static readonly string[] DirectDebitNames = ["Electric Ireland", "Vodafone Business", "Allianz Insurance", "Regus Offices", "DHL Express", "Amazon Web Services"];
    private static readonly string[] CardNames = ["Lufthansa Corporate Travel", "Booking.com Business", "Staples Direct", "Uber for Business"];

    /// <summary>Builds the statements and their entries.</summary>
    internal static List<BankStatementRecord> Create(Random rng, DateTimeOffset now, DateOnly today, IReadOnlyList<AccountRecord> accounts,
        IReadOnlyList<PaymentRecord> payments, IReadOnlyList<CounterpartyRecord> counterparties)
    {
        var customers = counterparties.Where(c => c.Type == CounterpartyType.Customer).ToList();
        var byId = counterparties.ToDictionary(c => c.Id);
        var days = Enumerable.Range(1, 14).Select(back => today.AddDays(-back)).Where(d => d.DayOfWeek is not (DayOfWeek.Saturday or DayOfWeek.Sunday)).ToList();
        var statements = new List<BankStatementRecord>();
        var reported = accounts.Where(a => a.Status == AccountStatus.Open &&
            (a.Type == AccountType.Operating || a.Name is "Dublin Collections EUR" or "Frankfurt Collections EUR")).ToList();

        foreach (var account in reported)
        {
            var scale = PaymentSeed.Scale(account.Currency);
            var decimals = EndpointSupport.Decimals(account.Currency);
            var collections = account.Type == AccountType.Collections;
            var closing = account.LedgerBalance;
            // Walk back in time: the latest statement closes at the current ledger balance.
            foreach (var day in days)
            {
                var statement = new BankStatementRecord
                {
                    Id = rng.NextGuid(), Number = $"{account.Bic[..4]}-{day:yyyyMMdd}-{rng.Between(100, 999)}", AccountId = account.Id,
                    Currency = account.Currency, StatementDate = day, ClosingBalance = closing,
                    ReceivedAt = Min(now.AddMinutes(-1), new DateTimeOffset(day.AddDays(1).ToDateTime(new TimeOnly(5, rng.Between(10, 50)), DateTimeKind.Utc)))
                };
                var entries = new List<StatementEntryRecord>();
                StatementEntryRecord Add(StatementEntryType type, decimal amount, string code, string? name, string? remittance, string? endToEnd = null, Guid? matched = null)
                {
                    var entry = new StatementEntryRecord
                    {
                        Id = rng.NextGuid(), Type = type, Amount = decimal.Round(amount, decimals), BookingDate = day, ValueDate = day,
                        EntryReference = $"BK{rng.Digits(10)}", EndToEndId = endToEnd, CounterpartyName = name, Remittance = remittance,
                        BankTransactionCode = code, MatchedPaymentId = matched
                    };
                    entries.Add(entry);
                    return entry;
                }

                foreach (var payment in payments.Where(p => p.DebitAccountId == account.Id && p.ValueDate == day &&
                    p.Status is PaymentStatus.Settled or PaymentStatus.Sent))
                {
                    var counterparty = byId[payment.CounterpartyId];
                    var domestic = counterparty.Country == account.EntityCountry && account.Currency == Currency.EUR;
                    Add(StatementEntryType.Debit, payment.Amount, domestic ? "PMNT-ICDT-ESCT" : "PMNT-ICDT-XBCT", counterparty.Name,
                        payment.Reference, payment.Number, payment.Id);
                }
                var receipts = collections ? rng.Between(3, 6) : rng.Between(0, 3);
                for (var i = 0; i < receipts; i++)
                {
                    var customer = rng.Pick(customers);
                    Add(StatementEntryType.Credit, rng.Amount(collections ? 5_000m : 3_000m, collections ? 120_000m : 90_000m, account.Currency) * scale,
                        "PMNT-RCDT-ESCT", customer.Name, $"Invoice INV-{today.Year}-{rng.Between(1000, 9999)}", $"E2E{rng.Digits(8)}");
                }
                for (var i = rng.Between(0, 2); i > 0; i--)
                    Add(StatementEntryType.Debit, rng.Amount(300m, 9_000m, account.Currency) * scale,
                        collections ? "PMNT-ICDT-ESCT" : "PMNT-IDDT-ESDD", rng.Pick(collections ? CardNames : DirectDebitNames), "Direct debit mandate " + rng.Digits(6));
                if (rng.Chance(0.4))
                    Add(StatementEntryType.Fee, rng.Amount(8m, 45m, account.Currency) * scale, "ACMT-MDOP-CHRG", account.BankName, "Account maintenance and transaction fees");
                if (rng.Chance(0.1))
                    Add(StatementEntryType.Interest, rng.Amount(20m, 400m, account.Currency) * scale, "ACMT-MDOP-INTR", account.BankName, "Credit interest");

                var net = Net(entries);
                // Keep a healthy opening balance: add a customer receipt when the day would start too low.
                var floor = account.LedgerBalance * 0.05m;
                if (closing - net < floor)
                {
                    var top = decimal.Round(floor - (closing - net) + rng.Amount(5_000m, 40_000m, account.Currency) * scale, decimals);
                    Add(StatementEntryType.Credit, top, "PMNT-RCDT-ESCT", rng.Pick(customers).Name, "Customer receipt", $"E2E{rng.Digits(8)}");
                    net = Net(entries);
                }
                statement.OpeningBalance = decimal.Round(closing - net, decimals);
                var sequence = 1;
                foreach (var entry in entries.OrderBy(e => e.Type == StatementEntryType.Fee ? 2 : e.Type == StatementEntryType.Interest ? 3 : rng.Next(2)))
                {
                    entry.Sequence = sequence++;
                    statement.Entries.Add(entry);
                }
                statements.Add(statement);
                closing = statement.OpeningBalance;
            }
        }
        return statements;
    }

    /// <summary>The effect of a statement's entries on the balance: credits and interest add, debits and fees subtract.</summary>
    private static decimal Net(IEnumerable<StatementEntryRecord> entries) =>
        entries.Sum(e => e.Type is StatementEntryType.Credit or StatementEntryType.Interest ? e.Amount : -e.Amount);

    private static DateTimeOffset Min(DateTimeOffset a, DateTimeOffset b) => a < b ? a : b;
}
