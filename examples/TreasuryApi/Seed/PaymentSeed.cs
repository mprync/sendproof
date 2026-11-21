using System.Text.Json;

namespace TreasuryApi;

/// <summary>The rows produced by <see cref="PaymentSeed"/>.</summary>
/// <param name="Payments">Payments in every status.</param>
/// <param name="Approvals">Approval and rejection decisions.</param>
/// <param name="Audit">Audit events, several per payment.</param>
/// <param name="Reserved">Funds reserved by active payments, per debit account.</param>
internal sealed record PaymentSeedResult(List<PaymentRecord> Payments, List<PaymentApprovalRecord> Approvals,
    List<AuditEventRecord> Audit, Dictionary<Guid, decimal> Reserved);

/// <summary>
/// Seeds about 190 payments in all nine statuses with cents, remittance text, purpose codes, approval history and
/// audit events. Value dates span the last 90 days and the next 30.
/// </summary>
internal static class PaymentSeed
{
    private const string SystemActor = "payments-scheduler@acme.dev";
    private const string BankActor = "bank-gateway@acme.dev";

    private static readonly (PaymentStatus Status, int Count)[] Plan =
    [
        (PaymentStatus.Settled, 62), (PaymentStatus.Sent, 14), (PaymentStatus.Scheduled, 18), (PaymentStatus.Approved, 12),
        (PaymentStatus.PendingApproval, 24), (PaymentStatus.Draft, 22), (PaymentStatus.Rejected, 14), (PaymentStatus.Failed, 8),
        (PaymentStatus.Cancelled, 14)
    ];

    private static readonly string[] SupplierMemos =
    [
        "Q3 freight", "Q4 freight", "Packaging Oct", "Maintenance contract", "Cloud hosting Nov", "Spare parts PO", "Office supplies",
        "Catering Oct", "Consulting retainer", "Legal fees", "Software licences", "Pallet haulage", "Steel coil order", "Telecom Q4"
    ];

    private static readonly string[] CustomerMemos = ["Credit note", "Overpayment refund", "Rebate Q3", "Returned goods", "Volume rebate"];
    private static readonly string[] InterCompanyMemos = ["Management fee", "Loan interest Q3", "Cost recharge", "Cash pool top-up", "Dividend", "IT recharge"];
    private static readonly string[] TaxMemos = ["VAT Q3", "Payroll tax Oct", "Corp tax prepayment", "VAT Q2", "Withholding tax", "Customs duty"];

    private static readonly string[] RejectionReasons =
    [
        "Amount does not match the invoice.", "Wrong beneficiary account: please verify the IBAN with the supplier.",
        "Missing purchase order reference.", "Duplicate of an earlier payment.", "Value date too early for the contract terms."
    ];

    private static readonly string[] FailureReasons =
    [
        "AC03: Invalid creditor account number.", "AC04: Beneficiary account closed.", "RR04: Regulatory reason, payment held for screening.",
        "AM04: Insufficient funds at the intermediary bank.", "BE01: Creditor name does not match the account holder."
    ];

    private static readonly string[] CancelReasons =
    [
        "Invoice disputed with the supplier.", "Paid by another entity.", "Created in error.", "Superseded by a corrected payment.", "Supplier asked us to hold."
    ];

    /// <summary>The currency a country's counterparties are normally paid in.</summary>
    private static Currency CurrencyOf(string country) => country switch
    {
        "GB" => Currency.GBP, "US" or "SG" or "CN" or "IN" => Currency.USD, "SE" => Currency.SEK, "NO" => Currency.NOK, "CH" => Currency.CHF,
        "DK" => Currency.DKK, "PL" => Currency.PLN, "JP" => Currency.JPY, "CA" => Currency.CAD, _ => Currency.EUR
    };

    /// <summary>Roughly how many units of a currency equal 1 EUR, to scale amounts.</summary>
    internal static decimal Scale(Currency currency) => currency switch
    {
        Currency.SEK => 11m, Currency.JPY => 160m, Currency.GBP => 0.85m, Currency.CHF => 0.95m, Currency.USD => 1.08m, _ => 1m
    };

    /// <summary>Creates the payments, their decisions and audit trail.</summary>
    internal static PaymentSeedResult Create(Random rng, DateTimeOffset now, DateOnly today, IReadOnlyList<DemoUser> users,
        IReadOnlyList<AccountRecord> accounts, IReadOnlyList<CounterpartyRecord> counterparties)
    {
        var workers = users.Where(u => u.IsActive && u.Role is "payments.approve" or "admin").ToList();
        var weightedCreators = new List<DemoUser>();
        foreach (var user in workers)
            weightedCreators.AddRange(Enumerable.Repeat(user, user.Email switch
            {
                "tomas.treasurer@acme.dev" => 9, "ada.admin@acme.dev" => 4, "ben.approver@acme.dev" => 4, _ => 3
            }));
        var operating = accounts.Where(a => a.Type == AccountType.Operating && a.Status == AccountStatus.Open).ToList();
        var guarded = new HashSet<Guid> { Guid.Parse(DemoData.OperatingEurId), Guid.Parse(DemoData.OperatingUsdId) };
        var reserved = new Dictionary<Guid, decimal>();
        var payments = new List<PaymentRecord>();
        var approvals = new List<PaymentApprovalRecord>();
        var audit = new List<AuditEventRecord>();

        foreach (var (status, count) in Plan)
            for (var i = 0; i < count; i++)
            {
                var active = status is PaymentStatus.Draft or PaymentStatus.PendingApproval or PaymentStatus.Approved or PaymentStatus.Scheduled;
                // The two original demo accounts keep their exact balances, so they only carry finished payments.
                var account = rng.Pick(operating);
                while (active && guarded.Contains(account.Id)) account = rng.Pick(operating);
                var counterparty = ChooseCounterparty(rng, account, counterparties, active);
                var amount = ChooseAmount(rng, account, counterparty, active ? reserved.GetValueOrDefault(account.Id) : 0m);
                var creator = rng.Pick(weightedCreators);
                var payment = BuildPayment(rng, now, today, status, account, counterparty, amount, creator);
                payments.Add(payment);
                if (active) reserved[account.Id] = reserved.GetValueOrDefault(account.Id) + amount;
                AddHistory(rng, now, payment, creator, workers, approvals, audit);
            }

        // Numbers follow creation order within each year, like a real sequence.
        foreach (var group in payments.OrderBy(p => p.CreatedAt).GroupBy(p => p.CreatedAt.Year))
        {
            var sequence = 1;
            foreach (var payment in group) payment.Number = $"PAY-{group.Key}-{sequence++:000000}";
        }
        return new PaymentSeedResult(payments, approvals, audit, reserved);
    }

    private static CounterpartyRecord ChooseCounterparty(Random rng, AccountRecord account, IReadOnlyList<CounterpartyRecord> all, bool needActive)
    {
        var pool = all.Where(c => !needActive || c.Status == CounterpartyStatus.Active).ToList();
        var roll = rng.NextDouble();
        if (roll < 0.17)
        {
            var tax = pool.Where(c => c.Type == CounterpartyType.TaxAuthority && c.Country == account.EntityCountry).ToList();
            if (tax.Count > 0) return rng.Pick(tax);
        }
        else if (roll < 0.29)
        {
            var group = pool.Where(c => c.Type == CounterpartyType.Intercompany && c.Name != account.Entity).ToList();
            if (group.Count > 0) return rng.Pick(group);
        }
        else if (roll < 0.35)
        {
            var customers = pool.Where(c => c.Type == CounterpartyType.Customer && CurrencyOf(c.Country) == account.Currency).ToList();
            if (customers.Count > 0) return rng.Pick(customers);
        }
        var suppliers = pool.Where(c => c.Type == CounterpartyType.Supplier).ToList();
        var sameCurrency = suppliers.Where(c => CurrencyOf(c.Country) == account.Currency).ToList();
        return rng.Pick(sameCurrency.Count > 0 && rng.Chance(0.8) ? sameCurrency : suppliers);
    }

    private static decimal ChooseAmount(Random rng, AccountRecord account, CounterpartyRecord counterparty, decimal alreadyReserved)
    {
        var (min, max) = counterparty.Type switch
        {
            CounterpartyType.Customer => (400m, 45_000m),
            CounterpartyType.Intercompany => (50_000m, 1_500_000m),
            CounterpartyType.TaxAuthority => (12_000m, 420_000m),
            _ => (850m, 185_000m)
        };
        var scale = Scale(account.Currency);
        var amount = rng.Amount(min * scale, max * scale, account.Currency);
        // Round numbers are common for tax and intercompany settlements.
        if (counterparty.Type is CounterpartyType.Intercompany or CounterpartyType.TaxAuthority)
            amount = decimal.Round(amount / (1000m * scale), 0) * 1000m * scale;
        amount = Math.Min(amount, account.LedgerBalance * 0.3m);
        var room = account.LedgerBalance * 0.6m - alreadyReserved;
        amount = Math.Min(amount, Math.Max(room, 0m));
        amount = decimal.Round(amount, EndpointSupport.Decimals(account.Currency));
        return Math.Max(amount, EndpointSupport.Decimals(account.Currency) == 0 ? 1000m : 25.40m);
    }

    private static PaymentRecord BuildPayment(Random rng, DateTimeOffset now, DateOnly today, PaymentStatus status, AccountRecord account,
        CounterpartyRecord counterparty, decimal amount, DemoUser creator)
    {
        var valueDate = status switch
        {
            PaymentStatus.Settled => today.AddDays(-rng.Between(2, 90)),
            PaymentStatus.Sent => today.AddDays(-rng.Between(0, 1)),
            PaymentStatus.Failed => today.AddDays(-rng.Between(1, 30)),
            PaymentStatus.Scheduled => today.AddDays(rng.Between(1, 10)),
            PaymentStatus.Approved => today.AddDays(rng.Between(0, 7)),
            PaymentStatus.PendingApproval => today.AddDays(rng.Between(0, 14)),
            PaymentStatus.Draft => today.AddDays(rng.Between(0, 30)),
            PaymentStatus.Rejected => today.AddDays(rng.Between(-5, 20)),
            _ => today.AddDays(rng.Between(-20, 20))
        };
        valueDate = valueDate < today ? SeedRandom.PreviousBusinessDay(valueDate) : SeedRandom.BusinessDay(valueDate);
        // A payment is created some days before its value date, but never in the future.
        var created = status is PaymentStatus.Draft or PaymentStatus.PendingApproval or PaymentStatus.Approved or PaymentStatus.Scheduled
            ? now.AddDays(-rng.Between(0, 9)).AddMinutes(-rng.Between(40, 900))
            : new DateTimeOffset(valueDate.ToDateTime(new TimeOnly(rng.Between(8, 16), rng.Between(0, 59)), DateTimeKind.Utc)).AddDays(-rng.Between(2, 9));
        if (created > now.AddHours(-2)) created = now.AddHours(-2).AddMinutes(-rng.Between(0, 600));

        var crossBorder = counterparty.Country != account.EntityCountry;
        var year = today.Year;
        var reference = counterparty.Type switch
        {
            CounterpartyType.Customer => $"CN-{year}-{rng.Between(1000, 9999)} / {rng.Pick(CustomerMemos)}",
            CounterpartyType.Intercompany => $"IC-{year}-{rng.Between(100, 999)} / {rng.Pick(InterCompanyMemos)}",
            CounterpartyType.TaxAuthority => $"{rng.Pick(TaxMemos)} {year}",
            _ => $"INV-{year}-{rng.Between(1000, 9999)} / {rng.Pick(SupplierMemos)}"
        };
        List<string> lines = counterparty.Type switch
        {
            CounterpartyType.Supplier => new() { $"Invoice {reference.Split(' ')[0]}", $"PO {rng.Between(10000, 99999)}, delivery {rng.Between(1, 28)} {created:MMM}" },
            CounterpartyType.Customer => ["Credit note settlement", "Return of overpayment"],
            CounterpartyType.Intercompany => [$"Intercompany settlement {created:MMMM yyyy}"],
            _ => [$"Statutory payment, period {created:MMM yyyy}"]
        };
        var purposeCode = counterparty.Type switch
        {
            CounterpartyType.Intercompany => rng.Pick(new[] { PurposeCode.INTC, PurposeCode.LOAN, PurposeCode.CASH, PurposeCode.DIVD }),
            CounterpartyType.TaxAuthority => rng.Chance(0.8) ? PurposeCode.TAXS : PurposeCode.GOVT,
            CounterpartyType.Customer => PurposeCode.TRAD,
            _ => rng.Pick(new[] { PurposeCode.SUPP, PurposeCode.SUPP, PurposeCode.TRAD, PurposeCode.RENT, PurposeCode.UTIL, PurposeCode.INSU })
        };
        return new PaymentRecord
        {
            Id = rng.NextGuid(), Number = "", DebitAccountId = account.Id, CounterpartyId = counterparty.Id, Amount = amount,
            Currency = account.Currency, ValueDate = valueDate,
            Priority = rng.NextDouble() switch { < 0.8 => Priority.Normal, < 0.92 => Priority.Urgent, _ => Priority.SameDay },
            Reference = reference.Length > 35 ? reference[..35].TrimEnd() : reference,
            RemittanceLinesJson = JsonSerializer.Serialize(lines.Take(rng.Between(1, lines.Count)).ToArray()),
            ChargeBearer = crossBorder ? rng.NextDouble() switch { < 0.7 => ChargeBearer.SHA, < 0.9 => ChargeBearer.OUR, _ => ChargeBearer.BEN } : null,
            PurposeCode = purposeCode, ExternalId = rng.Chance(0.4) ? $"ERP-{rng.Digits(7)}" : null,
            Status = status, CreatedBy = creator.Email, CreatedAt = created, UpdatedAt = created
        };
    }

    /// <summary>Adds the decisions and audit events that lead to a payment's status, and sets its timestamps.</summary>
    private static void AddHistory(Random rng, DateTimeOffset now, PaymentRecord payment, DemoUser creator, IReadOnlyList<DemoUser> workers,
        List<PaymentApprovalRecord> approvals, List<AuditEventRecord> audit)
    {
        var at = payment.CreatedAt;
        DateTimeOffset Next(int minMinutes, int maxMinutes) => at = Min(now.AddMinutes(-1), at.AddMinutes(rng.Between(minMinutes, maxMinutes)));
        void Event(string action, string actor, DateTimeOffset when) => audit.Add(new AuditEventRecord
        {
            Id = rng.NextGuid(), EntityType = "Payment", EntityId = payment.Id.ToString(), Action = action, Actor = actor, CreatedAt = when
        });
        void Decide(ApprovalDecision decision, string? comment, DateTimeOffset when)
        {
            var reviewer = rng.Pick(workers.Where(w => w.Email != creator.Email).ToList());
            approvals.Add(new PaymentApprovalRecord
            {
                Id = rng.NextGuid(), PaymentId = payment.Id, Decision = decision, ActorEmail = reviewer.Email, ActorName = reviewer.Name,
                Comment = comment, DecidedAt = when
            });
            Event($"Payment.{decision}", reviewer.Email, when);
        }

        Event("Payment.Created", creator.Email, at);
        var status = payment.Status;
        if (status == PaymentStatus.Draft) { payment.UpdatedAt = at; return; }
        if (status == PaymentStatus.Cancelled && rng.Chance(0.4))
        {
            Event($"Payment.Cancelled: {rng.Pick(CancelReasons)}", creator.Email, Next(5, 3000));
            payment.UpdatedAt = at;
            return;
        }

        // A few payments were rejected once, fixed by their creator and submitted again.
        var resubmitted = status is PaymentStatus.PendingApproval or PaymentStatus.Approved or PaymentStatus.Scheduled or PaymentStatus.Sent or PaymentStatus.Settled
            && rng.Chance(0.12);
        payment.SubmittedAt = Next(10, 300);
        Event("Payment.Submitted", creator.Email, payment.SubmittedAt.Value);
        if (resubmitted)
        {
            Decide(ApprovalDecision.Rejected, rng.Pick(RejectionReasons), Next(30, 600));
            Event("Payment.Updated", creator.Email, Next(10, 240));
            payment.SubmittedAt = Next(5, 120);
            Event("Payment.Submitted", creator.Email, payment.SubmittedAt.Value);
        }
        switch (status)
        {
            case PaymentStatus.PendingApproval:
                break;
            case PaymentStatus.Rejected:
                Decide(ApprovalDecision.Rejected, rng.Pick(RejectionReasons), Next(30, 1500));
                break;
            case PaymentStatus.Cancelled:
                if (rng.Chance(0.5)) Decide(ApprovalDecision.Approved, null, Next(30, 1500));
                Event($"Payment.Cancelled: {rng.Pick(CancelReasons)}", creator.Email, Next(30, 2000));
                break;
            default:
                Decide(ApprovalDecision.Approved, rng.Chance(0.3) ? "Matches the invoice and PO." : null, Next(30, 1500));
                if (status == PaymentStatus.Approved) break;
                Event("Payment.Scheduled", SystemActor, Next(1, 60));
                if (status == PaymentStatus.Scheduled) break;
                var valueMorning = new DateTimeOffset(payment.ValueDate.ToDateTime(new TimeOnly(7, rng.Between(0, 40)), DateTimeKind.Utc));
                at = Min(now.AddMinutes(-1), Max(at, valueMorning));
                Event("Payment.Sent", BankActor, at);
                if (status == PaymentStatus.Settled) Event("Payment.Settled", BankActor, Next(60, 500));
                if (status == PaymentStatus.Failed)
                {
                    payment.FailureReason = rng.Pick(FailureReasons);
                    Event($"Payment.Failed: {payment.FailureReason}", BankActor, Next(30, 400));
                }
                break;
        }
        payment.UpdatedAt = at;
    }

    private static DateTimeOffset Min(DateTimeOffset a, DateTimeOffset b) => a < b ? a : b;
    private static DateTimeOffset Max(DateTimeOffset a, DateTimeOffset b) => a > b ? a : b;
}
