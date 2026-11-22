using System.ComponentModel.DataAnnotations;

namespace StoreApi;

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
public sealed class Money
{
    /// <summary>The amount, with at most two decimal places (none for JPY).</summary>
    public required decimal Value { get; init; }
    /// <summary>The ISO 4217 currency of the amount.</summary>
    public required Currency Currency { get; init; }
}

/// <summary>A postal address, used for delivery and billing.</summary>
public sealed class Address
{
    /// <summary>The person or company the parcel is for.</summary>
    [Required, MaxLength(80)] public string Recipient { get; set; } = "";
    /// <summary>The first address line: street and number.</summary>
    [Required, MaxLength(100)] public string Line1 { get; set; } = "";
    /// <summary>The second address line: apartment, suite or building.</summary>
    [MaxLength(100)] public string? Line2 { get; set; }
    /// <summary>The city or town.</summary>
    [Required, MaxLength(60)] public string City { get; set; } = "";
    /// <summary>The state, county or province, where the country has one.</summary>
    [MaxLength(60)] public string? Region { get; set; }
    /// <summary>The postal code.</summary>
    [Required, MaxLength(12)] public string PostalCode { get; set; } = "";
    /// <summary>The ISO 3166-1 alpha-2 country code, such as <c>IE</c>.</summary>
    [Required, RegularExpression("^[A-Z]{2}$")] public string Country { get; set; } = "";
}

/// <summary>A short description of a person, embedded in orders and events.</summary>
public sealed class ActorReference
{
    /// <summary>The person's email address.</summary>
    public required string Email { get; init; }
    /// <summary>The person's display name.</summary>
    public required string Name { get; init; }
}

/// <summary>A short description of a customer, embedded in orders and carts.</summary>
public sealed class CustomerReference
{
    /// <summary>The customer's ID. Use it with the customer operations.</summary>
    public required Guid Id { get; init; }
    /// <summary>The customer's full name.</summary>
    public required string Name { get; init; }
    /// <summary>The customer's email address.</summary>
    public required string Email { get; init; }
}

/// <summary>A short description of a variant, embedded in lines, stock levels and reservations.</summary>
public sealed class VariantReference
{
    /// <summary>The variant's ID.</summary>
    public required Guid Id { get; init; }
    /// <summary>The stock-keeping unit.</summary>
    public required string Sku { get; init; }
    /// <summary>The product's name with the variant's options, such as <c>Trailhead Pro Jacket, Black / M</c>.</summary>
    public required string Name { get; init; }
}
