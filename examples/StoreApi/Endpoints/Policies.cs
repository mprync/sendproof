using Microsoft.AspNetCore.Authorization;

namespace StoreApi;

/// <summary>
/// Role requirements shared by the endpoint groups. The roles are listed on each operation as its OAuth-style
/// scopes: <c>admin</c> runs the store, <c>support</c> helps customers, <c>warehouse</c> handles stock and shipments, and
/// <c>customer</c> is a shopper.
/// </summary>
internal static class Policies
{
    /// <summary>Store admins only: products, categories, coupons and user roles.</summary>
    internal static readonly Action<AuthorizationPolicyBuilder> Admins = policy => policy.RequireRole("admin");

    /// <summary>Everyone who works for the store; not customers.</summary>
    internal static readonly Action<AuthorizationPolicyBuilder> Staff = policy => policy.RequireRole("admin", "support", "warehouse");

    /// <summary>Staff who talk to customers: customer records, payments and refunds.</summary>
    internal static readonly Action<AuthorizationPolicyBuilder> Support = policy => policy.RequireRole("admin", "support");

    /// <summary>Staff who run the warehouse: stock levels and shipments.</summary>
    internal static readonly Action<AuthorizationPolicyBuilder> Warehouse = policy => policy.RequireRole("admin", "warehouse");

    /// <summary>People who can shop: customers, and staff acting for them. Warehouse staff cannot.</summary>
    internal static readonly Action<AuthorizationPolicyBuilder> Shoppers = policy => policy.RequireRole("admin", "support", "customer");
}
