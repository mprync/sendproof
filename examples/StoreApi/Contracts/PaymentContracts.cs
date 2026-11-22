using System.ComponentModel.DataAnnotations;

namespace StoreApi;

/// <summary>A refund of part or all of a payment.</summary>
public sealed class Refund
{
    /// <summary>The refund's ID.</summary>
    public required Guid Id { get; init; }
    /// <summary>The amount refunded.</summary>
    public required Money Amount { get; init; }
    /// <summary>Why it was refunded.</summary>
    public required RefundReason Reason { get; init; }
    /// <summary>An explanation.</summary>
    public string? Note { get; init; }
    /// <summary>Who refunded.</summary>
    public required string CreatedBy { get; init; }
    /// <summary>When it was refunded.</summary>
    public required DateTimeOffset CreatedAt { get; init; }
}

/// <summary>The payment taken for an order.</summary>
public sealed class Payment
{
    /// <summary>The payment's ID.</summary>
    public required Guid Id { get; init; }
    /// <summary>The order paid.</summary>
    public required Guid OrderId { get; init; }
    /// <summary>The order's number.</summary>
    public required string OrderNumber { get; init; }
    /// <summary>How the customer paid.</summary>
    public required PaymentMethodKind Method { get; init; }
    /// <summary>A display of the method, such as <c>Visa •••• 4242</c>.</summary>
    public required string MethodDisplay { get; init; }
    /// <summary>Where the payment is in its life.</summary>
    public required PaymentStatus Status { get; init; }
    /// <summary>The amount charged.</summary>
    public required Money Amount { get; init; }
    /// <summary>The part of the amount that was refunded.</summary>
    public required Money Refunded { get; init; }
    /// <summary>The payment provider's reference.</summary>
    public required string ProviderReference { get; init; }
    /// <summary>The refunds made, oldest first.</summary>
    public required IReadOnlyList<Refund> Refunds { get; init; }
    /// <summary>Why the payment failed. Present only when it did.</summary>
    public string? FailureReason { get; init; }
    /// <summary>When the payment was created.</summary>
    public required DateTimeOffset CreatedAt { get; init; }
}

/// <summary>A refund to make.</summary>
public sealed class RefundRequest
{
    /// <summary>The amount to refund, at most what is left of the payment.</summary>
    public decimal Amount { get; set; }
    /// <summary>The currency of <c>amount</c>. It must be the payment's currency.</summary>
    public string Currency { get; set; } = "USD";
    /// <summary>Why: <c>Damaged</c>, <c>Wrong item</c>, <c>Not as described</c>, <c>Customer request</c> or <c>Other</c>.</summary>
    public string Reason { get; set; } = "Customer request";
    /// <summary>An explanation, kept on the refund.</summary>
    [MaxLength(300)] public string? Note { get; set; }
}
