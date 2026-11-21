using System.ComponentModel.DataAnnotations;
using System.Text.Json.Serialization;

namespace TreasuryApi;

/// <summary>
/// A foreign exchange deal. The <c>type</c> property selects the variant: <c>Spot</c> deals settle two business
/// days after they are struck, <c>Forward</c> deals settle on an agreed later date.
/// </summary>
[JsonPolymorphic(TypeDiscriminatorPropertyName = "type")]
[JsonDerivedType(typeof(SpotFxDeal), "Spot")]
[JsonDerivedType(typeof(ForwardFxDeal), "Forward")]
public abstract class FxDeal
{
    /// <summary>The deal's unique ID.</summary>
    public required Guid Id { get; init; }
    /// <summary>The human-friendly deal number, such as <c>FX-2026-0042</c>.</summary>
    public required string Number { get; init; }
    /// <summary>The traded currency pair, base currency first.</summary>
    public required FxPair Pair { get; init; }
    /// <summary>Whether Acme buys or sells the base currency.</summary>
    public required FxSide Side { get; init; }
    /// <summary>The amount of the base currency.</summary>
    public required MoneyAmount BaseAmount { get; init; }
    /// <summary>The amount of the quote currency, at the dealt rate.</summary>
    public required MoneyAmount QuoteAmount { get; init; }
    /// <summary>The all-in dealt rate: units of the quote currency per unit of the base currency.</summary>
    public required decimal Rate { get; init; }
    /// <summary>Whether the deal is booked, settled or cancelled.</summary>
    public required FxDealStatus Status { get; init; }
    /// <summary>The date the deal was struck.</summary>
    public required DateOnly TradeDate { get; init; }
    /// <summary>The bank Acme dealt with.</summary>
    public required string Bank { get; init; }
    /// <summary>The dealer who booked the deal.</summary>
    public required ActorReference BookedBy { get; init; }
    /// <summary>When the deal was booked.</summary>
    public required DateTimeOffset BookedAt { get; init; }
    /// <summary>Why the deal was cancelled. Present only on cancelled deals.</summary>
    public string? CancelReason { get; init; }
}

/// <summary>A spot deal: currencies are exchanged two business days after the trade date.</summary>
public sealed class SpotFxDeal : FxDeal
{
    /// <summary>The date the currencies are exchanged.</summary>
    public required DateOnly SettlementDate { get; init; }
}

/// <summary>A forward deal: currencies are exchanged on an agreed date, at a rate fixed today.</summary>
public sealed class ForwardFxDeal : FxDeal
{
    /// <summary>The date the currencies are exchanged.</summary>
    public required DateOnly ValueDate { get; init; }
    /// <summary>The forward points added to the spot rate to reach the dealt rate.</summary>
    public required decimal ForwardPoints { get; init; }
    /// <summary>The number of calendar days from the trade date to the value date.</summary>
    public required int DaysToMaturity { get; init; }
}

/// <summary>Asks for an indicative rate.</summary>
public sealed class FxQuoteRequest
{
    /// <summary>The currency pair to quote, base currency first.</summary>
    [Required] public FxPair Pair { get; set; } = FxPair.EURUSD;
    /// <summary>Whether Acme wants to buy or sell the base currency.</summary>
    [Required] public FxSide Side { get; set; } = FxSide.Buy;
    /// <summary>Spot or forward.</summary>
    [Required] public FxDealType Type { get; set; } = FxDealType.Spot;
    /// <summary>The amount of the base currency, to at most two decimal places.</summary>
    [Range(typeof(decimal), "1", "999999999999.99")] public decimal BaseAmount { get; set; }
    /// <summary>The value date of a forward deal. Required for forwards, 3 to 365 days from today; ignored for spot.</summary>
    public DateOnly? ValueDate { get; set; }
}

/// <summary>An indicative rate, valid for a short time.</summary>
public sealed class FxQuote
{
    /// <summary>The currency pair, base currency first.</summary>
    public required FxPair Pair { get; init; }
    /// <summary>Whether Acme buys or sells the base currency.</summary>
    public required FxSide Side { get; init; }
    /// <summary>Spot or forward.</summary>
    public required FxDealType Type { get; init; }
    /// <summary>The all-in rate that booking would deal at.</summary>
    public required decimal Rate { get; init; }
    /// <summary>The forward points included in the rate. Zero for spot.</summary>
    public required decimal ForwardPoints { get; init; }
    /// <summary>The amount of the base currency.</summary>
    public required MoneyAmount BaseAmount { get; init; }
    /// <summary>The amount of the quote currency at the quoted rate.</summary>
    public required MoneyAmount QuoteAmount { get; init; }
    /// <summary>The date the currencies would be exchanged.</summary>
    public required DateOnly ValueDate { get; init; }
    /// <summary>When the quote stops being bookable.</summary>
    public required DateTimeOffset ValidUntil { get; init; }
}

/// <summary>Books a deal at a rate previously returned by the quote operation.</summary>
public sealed class BookFxDealRequest
{
    /// <summary>The currency pair, base currency first.</summary>
    [Required] public FxPair Pair { get; set; } = FxPair.EURUSD;
    /// <summary>Whether Acme buys or sells the base currency.</summary>
    [Required] public FxSide Side { get; set; } = FxSide.Buy;
    /// <summary>Spot or forward.</summary>
    [Required] public FxDealType Type { get; set; } = FxDealType.Spot;
    /// <summary>The amount of the base currency, to at most two decimal places.</summary>
    [Range(typeof(decimal), "1", "999999999999.99")] public decimal BaseAmount { get; set; }
    /// <summary>The rate from the quote. Booking fails with 409 when the market has moved more than 0.1% since.</summary>
    [Range(typeof(decimal), "0.0001", "100000")] public decimal Rate { get; set; }
    /// <summary>The value date of a forward deal. Required for forwards; ignored for spot.</summary>
    public DateOnly? ValueDate { get; set; }
}

/// <summary>An optional reason for cancelling an FX deal.</summary>
public sealed class CancelFxDealRequest
{
    /// <summary>Why the deal is being cancelled, up to 200 characters.</summary>
    [MaxLength(200)] public string? Reason { get; set; }
}
