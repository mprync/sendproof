using System.Text.Json;
using Microsoft.EntityFrameworkCore;

namespace TreasuryApi;

/// <summary>Maps persistence records to the contracts the API returns.</summary>
internal static class Mapping
{
    /// <summary>Maps a stored role name to the documented enum.</summary>
    internal static RoleName ToRole(string role) => role switch
    {
        "admin" => RoleName.Admin,
        "payments.approve" => RoleName.PaymentsApprove,
        _ => RoleName.ReadOnly
    };

    /// <summary>Maps a documented role to the stored role name.</summary>
    internal static string ToRoleClaim(RoleName role) => role switch
    {
        RoleName.Admin => "admin",
        RoleName.PaymentsApprove => "payments.approve",
        _ => "read-only"
    };

    internal static User ToContract(this DemoUser user) => new()
    {
        Id = user.Id, Email = user.Email, Name = user.Name, Role = ToRole(user.Role), JobTitle = user.JobTitle, IsActive = user.IsActive
    };

    internal static Account ToContract(this AccountRecord a) => new()
    {
        Id = a.Id, Name = a.Name, Entity = a.Entity, EntityCountry = a.EntityCountry, BankName = a.BankName, Bic = a.Bic,
        Iban = a.Iban, Currency = a.Currency, Type = a.Type, Status = a.Status, AvailableBalance = a.AvailableBalance,
        LedgerBalance = a.LedgerBalance, OpenedOn = a.OpenedOn, ClosedOn = a.ClosedOn, Description = a.Description
    };

    internal static AccountReference ToReference(this AccountRecord a) =>
        new() { Id = a.Id, Name = a.Name, Iban = a.Iban, Currency = a.Currency };

    internal static CounterpartyReference ToReference(this CounterpartyRecord c) =>
        new() { Id = c.Id, Name = c.Name, Country = c.Country };

    internal static MoneyAmount Money(decimal value, Currency currency) => new() { Value = value, Currency = currency };

    /// <summary>Reads the bank details stored in flat columns as the documented polymorphic contract.</summary>
    internal static BankDetails ToBankDetails(this CounterpartyRecord c) => c.BankScheme switch
    {
        BankScheme.UsAch => new UsAchBankDetails { RoutingNumber = c.RoutingNumber ?? "", AccountNumber = c.AccountNumber ?? "", BankName = c.BankName },
        BankScheme.Swift => new SwiftBankDetails { Bic = c.Bic ?? "", AccountNumber = c.AccountNumber ?? "", BankName = c.BankName },
        _ => new IbanBankDetails { Iban = c.Iban ?? "", Bic = c.Bic }
    };

    /// <summary>Copies documented bank details into the flat columns of a counterparty.</summary>
    internal static void SetBankDetails(this CounterpartyRecord c, BankDetails details)
    {
        c.Iban = c.Bic = c.RoutingNumber = c.AccountNumber = c.BankName = null;
        switch (details)
        {
            case IbanBankDetails iban:
                c.BankScheme = BankScheme.Iban; c.Iban = IbanTools.Format(iban.Iban); c.Bic = iban.Bic; break;
            case UsAchBankDetails ach:
                c.BankScheme = BankScheme.UsAch; c.RoutingNumber = ach.RoutingNumber; c.AccountNumber = ach.AccountNumber; c.BankName = ach.BankName; break;
            case SwiftBankDetails swift:
                c.BankScheme = BankScheme.Swift; c.Bic = swift.Bic; c.AccountNumber = swift.AccountNumber; c.BankName = swift.BankName; break;
        }
    }

    internal static Counterparty ToContract(this CounterpartyRecord c)
    {
        var details = c.ToBankDetails();
        return new()
        {
            Id = c.Id, Name = c.Name, Type = c.Type, Status = c.Status, Country = c.Country,
            Address = new Address { Line = c.AddressLine, City = c.City, PostalCode = c.PostalCode },
            ContactEmail = c.ContactEmail, BankDetails = details, AccountIdentifier = details.DisplayIdentifier, CreatedAt = c.CreatedAt
        };
    }

    internal static FxDeal ToContract(this FxDealRecord d, string bookedByName)
    {
        var (@base, quote) = Currencies(d.Pair);
        var booked = new ActorReference { Email = d.BookedBy, Name = bookedByName };
        if (d.Type == FxDealType.Spot)
            return new SpotFxDeal
            {
                Id = d.Id, Number = d.Number, Pair = d.Pair, Side = d.Side, BaseAmount = Money(d.BaseAmount, @base),
                QuoteAmount = Money(d.QuoteAmount, quote), Rate = d.Rate, Status = d.Status, TradeDate = d.TradeDate, Bank = d.Bank,
                BookedBy = booked, BookedAt = d.BookedAt, CancelReason = d.CancelReason, SettlementDate = d.ValueDate
            };
        return new ForwardFxDeal
        {
            Id = d.Id, Number = d.Number, Pair = d.Pair, Side = d.Side, BaseAmount = Money(d.BaseAmount, @base),
            QuoteAmount = Money(d.QuoteAmount, quote), Rate = d.Rate, Status = d.Status, TradeDate = d.TradeDate, Bank = d.Bank,
            BookedBy = booked, BookedAt = d.BookedAt, CancelReason = d.CancelReason, ValueDate = d.ValueDate,
            ForwardPoints = d.ForwardPoints, DaysToMaturity = d.ValueDate.DayNumber - d.TradeDate.DayNumber
        };
    }

    /// <summary>Splits a pair such as <c>EURUSD</c> into its base and quote currencies.</summary>
    internal static (Currency Base, Currency Quote) Currencies(FxPair pair)
    {
        var text = pair.ToString();
        return (Enum.Parse<Currency>(text[..3]), Enum.Parse<Currency>(text[3..]));
    }

    internal static StatementEntry ToContract(this StatementEntryRecord e, Currency currency) => new()
    {
        Id = e.Id, Sequence = e.Sequence, Type = e.Type, Amount = Money(e.Amount, currency), BookingDate = e.BookingDate,
        ValueDate = e.ValueDate, EntryReference = e.EntryReference, EndToEndId = e.EndToEndId, CounterpartyName = e.CounterpartyName,
        Remittance = e.Remittance, BankTransactionCode = e.BankTransactionCode, MatchedPaymentId = e.MatchedPaymentId
    };

    /// <summary>Maps payments to contracts, loading their accounts, counterparties, approvals and creators in bulk.</summary>
    internal static async Task<IReadOnlyList<Payment>> ToContractsAsync(this IReadOnlyList<PaymentRecord> payments, TreasuryDbContext db)
    {
        if (payments.Count == 0) return [];
        var ids = payments.Select(p => p.Id).ToList();
        var accountIds = payments.Select(p => p.DebitAccountId).Distinct().ToList();
        var counterpartyIds = payments.Select(p => p.CounterpartyId).Distinct().ToList();
        var emails = payments.Select(p => p.CreatedBy).Distinct().ToList();
        var accounts = await db.Accounts.AsNoTracking().Where(a => accountIds.Contains(a.Id)).ToDictionaryAsync(a => a.Id);
        var counterparties = await db.Counterparties.AsNoTracking().Where(c => counterpartyIds.Contains(c.Id)).ToDictionaryAsync(c => c.Id);
        var approvals = (await db.PaymentApprovals.AsNoTracking().Where(a => ids.Contains(a.PaymentId)).ToListAsync())
            .OrderBy(a => a.DecidedAt).ToLookup(a => a.PaymentId);
        var users = await db.Users.AsNoTracking().Where(u => emails.Contains(u.Email)).ToDictionaryAsync(u => u.Email);
        return payments.Select(p => new Payment
        {
            Id = p.Id, Number = p.Number, Status = p.Status, DebitAccount = accounts[p.DebitAccountId].ToReference(),
            Counterparty = counterparties[p.CounterpartyId].ToReference(), Amount = p.Amount, Currency = p.Currency,
            ValueDate = p.ValueDate, Priority = p.Priority, Reference = p.Reference,
            RemittanceInformation = p.RemittanceLinesJson is null ? null : new RemittanceInformation
            {
                Lines = JsonSerializer.Deserialize<string[]>(p.RemittanceLinesJson) ?? [], EndToEndId = p.Number
            },
            ChargeBearer = p.ChargeBearer, PurposeCode = p.PurposeCode, ExternalId = p.ExternalId,
            Approvals = approvals[p.Id].Select(a => new Approval
            {
                Id = a.Id, Decision = a.Decision, Actor = new ActorReference { Email = a.ActorEmail, Name = a.ActorName },
                Comment = a.Comment, DecidedAt = a.DecidedAt
            }).ToList(),
            CreatedBy = new ActorReference { Email = p.CreatedBy, Name = users.GetValueOrDefault(p.CreatedBy)?.Name ?? p.CreatedBy },
            CreatedAt = p.CreatedAt, UpdatedAt = p.UpdatedAt, SubmittedAt = p.SubmittedAt, FailureReason = p.FailureReason
        }).ToList();
    }

    /// <summary>Maps one payment to its contract.</summary>
    internal static async Task<Payment> ToContractAsync(this PaymentRecord payment, TreasuryDbContext db) =>
        (await new[] { payment }.ToContractsAsync(db))[0];
}
