using System.ComponentModel.DataAnnotations;

namespace TreasuryApi;

// Contracts shared by several tags. Every contract is a documented, sealed class so the generated OpenAPI
// document can reuse the XML comments as schema and property descriptions.

/// <summary>One page of a list, with the paging metadata needed to fetch the others.</summary>
/// <typeparam name="T">The type of item listed.</typeparam>
public sealed class PagedList<T>
{
    /// <summary>The items on this page, in the requested sort order.</summary>
    public required IReadOnlyList<T> Items { get; init; }
    /// <summary>The 1-based number of this page.</summary>
    public required int Page { get; init; }
    /// <summary>The maximum number of items on a page, as requested.</summary>
    public required int PageSize { get; init; }
    /// <summary>The number of items that match the filters across all pages.</summary>
    public required int TotalItems { get; init; }
    /// <summary>The number of pages needed to list every matching item (zero when nothing matches).</summary>
    public required int TotalPages { get; init; }
}

/// <summary>A monetary amount with its currency.</summary>
public sealed class MoneyAmount
{
    /// <summary>The amount, with at most two decimal places (none for JPY).</summary>
    public required decimal Value { get; init; }
    /// <summary>The ISO 4217 currency of the amount.</summary>
    public required Currency Currency { get; init; }
}

/// <summary>A short description of a bank account, embedded in payments and statements.</summary>
public sealed class AccountReference
{
    /// <summary>The account's ID. Use it with the account operations.</summary>
    public required Guid Id { get; init; }
    /// <summary>The account's short display name.</summary>
    public required string Name { get; init; }
    /// <summary>The account's IBAN.</summary>
    public required string Iban { get; init; }
    /// <summary>The currency of the account.</summary>
    public required Currency Currency { get; init; }
}

/// <summary>A short description of a counterparty, embedded in payments.</summary>
public sealed class CounterpartyReference
{
    /// <summary>The counterparty's ID. Use it with the counterparty operations.</summary>
    public required Guid Id { get; init; }
    /// <summary>The counterparty's registered name.</summary>
    public required string Name { get; init; }
    /// <summary>The ISO 3166-1 alpha-2 country of the counterparty.</summary>
    public required string Country { get; init; }
}

/// <summary>A person who took an action, such as creating or approving a payment.</summary>
public sealed class ActorReference
{
    /// <summary>The person's sign-in email address.</summary>
    public required string Email { get; init; }
    /// <summary>The person's display name.</summary>
    public required string Name { get; init; }
}

/// <summary>A postal address.</summary>
public sealed class Address
{
    /// <summary>Street and number, or the post-office box.</summary>
    [Required, MaxLength(70)] public string Line { get; set; } = "";
    /// <summary>The town or city.</summary>
    [Required, MaxLength(35)] public string City { get; set; } = "";
    /// <summary>The postal or ZIP code, where the country uses one.</summary>
    [MaxLength(16)] public string? PostalCode { get; set; }
}
