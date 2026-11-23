using Sendproof.Journeys;

namespace StoreApi;

/// <summary>The store's approved differences: each one allows a known difference between a journey's expectations and what the API writes.</summary>
public static class StoreApprovedDifferences
{
    /// <summary>The audit trail names a carrier by its code since 2.1.</summary>
    public static readonly ApprovedDifference<string> CarrierRenamed = new()
    {
        Id = "AD-0011",
        Actual = "Order.Shipped: Dhl",
        Reason = "The carrier catalog renamed DHL to Dhl (shown as DHL Express) in 2.1, and the audit trail writes the new code. Expectations still say DHL until they're re-recorded.",
        ApprovedBy = "sam.support@acme.dev",
        ApprovedOn = new DateOnly(2026, 11, 12),
        Expires = new DateOnly(2026, 12, 31),
        Link = "https://github.com/acme/store-api/issues/412",
    };
}
