using System.ComponentModel.DataAnnotations;

namespace StoreApi;

/// <summary>A shopper's profile.</summary>
public sealed class Customer
{
    /// <summary>The customer's ID.</summary>
    public required Guid Id { get; init; }
    /// <summary>The customer's email address.</summary>
    public required string Email { get; init; }
    /// <summary>The full name, given name first.</summary>
    public required string Name { get; init; }
    /// <summary>The given name.</summary>
    public required string FirstName { get; init; }
    /// <summary>The family name.</summary>
    public required string LastName { get; init; }
    /// <summary>The phone number in international format.</summary>
    public string? Phone { get; init; }
    /// <summary>The currency the customer shops in.</summary>
    public required Currency PreferredCurrency { get; init; }
    /// <summary>The loyalty tier.</summary>
    public required CustomerTier Tier { get; init; }
    /// <summary>Whether the customer agreed to marketing email.</summary>
    public required bool MarketingOptIn { get; init; }
    /// <summary>How many orders the customer has placed.</summary>
    public required int OrderCount { get; init; }
    /// <summary>What the customer has spent on orders that were not cancelled, in their preferred currency.</summary>
    public required Money LifetimeSpend { get; init; }
    /// <summary>When the customer registered.</summary>
    public required DateTimeOffset CreatedAt { get; init; }
}

/// <summary>The details a shopper registers with.</summary>
public sealed class RegisterCustomerRequest
{
    /// <summary>The email address. It must not be registered already.</summary>
    [Required, EmailAddress, MaxLength(120)] public string Email { get; set; } = "";
    /// <summary>The given name.</summary>
    [Required, MaxLength(40)] public string FirstName { get; set; } = "";
    /// <summary>The family name.</summary>
    [Required, MaxLength(40)] public string LastName { get; set; } = "";
    /// <summary>The phone number in international format, such as <c>+353 87 123 4567</c>.</summary>
    [RegularExpression(@"^\+[0-9 ]{7,18}$")] public string? Phone { get; set; }
    /// <summary>The currency the customer shops in.</summary>
    public string PreferredCurrency { get; set; } = "USD";
    /// <summary>Whether the customer agrees to marketing email.</summary>
    public bool MarketingOptIn { get; set; }
}

/// <summary>The new values of a customer profile. Every field is replaced.</summary>
public sealed class UpdateCustomerRequest
{
    /// <summary>The given name.</summary>
    [Required, MaxLength(40)] public string FirstName { get; set; } = "";
    /// <summary>The family name.</summary>
    [Required, MaxLength(40)] public string LastName { get; set; } = "";
    /// <summary>The phone number in international format.</summary>
    [RegularExpression(@"^\+[0-9 ]{7,18}$")] public string? Phone { get; set; }
    /// <summary>The currency the customer shops in.</summary>
    public string PreferredCurrency { get; set; } = "USD";
    /// <summary>Whether the customer agrees to marketing email.</summary>
    public bool MarketingOptIn { get; set; }
}

/// <summary>An address saved on a customer.</summary>
public sealed class CustomerAddress
{
    /// <summary>The address's ID.</summary>
    public required Guid Id { get; init; }
    /// <summary>Shipping or billing.</summary>
    public required AddressKind Kind { get; init; }
    /// <summary>A label such as <c>Home</c>.</summary>
    public required string Label { get; init; }
    /// <summary>Whether this is the customer's default for its kind.</summary>
    public required bool IsDefault { get; init; }
    /// <summary>The address itself.</summary>
    public required Address Address { get; init; }
}

/// <summary>A new address for a customer.</summary>
public sealed class AddAddressRequest
{
    /// <summary>Shipping or billing.</summary>
    public string Kind { get; set; } = "Shipping";
    /// <summary>A label such as <c>Home</c> or <c>Office</c>.</summary>
    [Required, MaxLength(30)] public string Label { get; set; } = "";
    /// <summary>Whether to make it the default for its kind.</summary>
    public bool MakeDefault { get; set; }
    /// <summary>The address itself.</summary>
    [Required] public Address Address { get; set; } = new();
}
