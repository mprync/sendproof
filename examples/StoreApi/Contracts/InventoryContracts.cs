using System.ComponentModel.DataAnnotations;

namespace StoreApi;

/// <summary>How much of a variant a warehouse holds.</summary>
public sealed class StockLevel
{
    /// <summary>The ID of the variant counted.</summary>
    public required Guid VariantId { get; init; }
    /// <summary>The stock-keeping unit. Use it with the other stock operations.</summary>
    public required string Sku { get; init; }
    /// <summary>The product's name with the variant's options.</summary>
    public required string Name { get; init; }
    /// <summary>The warehouse code, such as <c>DUB-01</c>.</summary>
    public required string Warehouse { get; init; }
    /// <summary>The units on the shelf, including reserved ones.</summary>
    public required int OnHand { get; init; }
    /// <summary>The units held for carts and unshipped orders.</summary>
    public required int Reserved { get; init; }
    /// <summary>The units that can be bought: on hand minus reserved.</summary>
    public required int Available { get; init; }
    /// <summary>The level at which the warehouse reorders.</summary>
    public required int ReorderPoint { get; init; }
    /// <summary>Whether the available units are at or below the reorder point.</summary>
    public required bool IsLow { get; init; }
    /// <summary>When the level last changed.</summary>
    public required DateTimeOffset UpdatedAt { get; init; }
}

/// <summary>A change to apply to a stock level.</summary>
public sealed class AdjustStockRequest
{
    /// <summary>The units to add (positive) or remove (negative). It cannot be zero.</summary>
    public int Delta { get; set; }
    /// <summary>Why the stock moves: <c>Received</c>, <c>Returned</c>, <c>Adjustment</c> or <c>Damaged</c>.</summary>
    public string Reason { get; set; } = "Adjustment";
    /// <summary>The delivery note or count sheet behind the change.</summary>
    [MaxLength(80)] public string? Reference { get; set; }
}

/// <summary>A change to a stock level.</summary>
public sealed class StockMovement
{
    /// <summary>The movement's ID.</summary>
    public required Guid Id { get; init; }
    /// <summary>The units added (positive) or removed (negative).</summary>
    public required int Delta { get; init; }
    /// <summary>Why the stock moved.</summary>
    public required StockReason Reason { get; init; }
    /// <summary>The order or delivery behind the movement.</summary>
    public string? Reference { get; init; }
    /// <summary>Who or what moved the stock.</summary>
    public required string Actor { get; init; }
    /// <summary>When it moved.</summary>
    public required DateTimeOffset CreatedAt { get; init; }
}

/// <summary>Stock held for a cart or an order.</summary>
public sealed class Reservation
{
    /// <summary>The reservation's ID.</summary>
    public required Guid Id { get; init; }
    /// <summary>The variant held.</summary>
    public required VariantReference Variant { get; init; }
    /// <summary>The units held.</summary>
    public required int Quantity { get; init; }
    /// <summary>Whether the reservation still holds stock.</summary>
    public required ReservationStatus Status { get; init; }
    /// <summary>The order the stock is committed to. Absent for a cart hold.</summary>
    public Guid? OrderId { get; init; }
    /// <summary>When a held reservation expires and its stock is released.</summary>
    public required DateTimeOffset ExpiresAt { get; init; }
    /// <summary>When the reservation was made.</summary>
    public required DateTimeOffset CreatedAt { get; init; }
}

/// <summary>The stock level as the retired v1 operation reported it.</summary>
public sealed class LegacyStockLevel
{
    /// <summary>The product's ID.</summary>
    public required Guid ProductId { get; init; }
    /// <summary>The units available across all variants.</summary>
    public required int Quantity { get; init; }
}
