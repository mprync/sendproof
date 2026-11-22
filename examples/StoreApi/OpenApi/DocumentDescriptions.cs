using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

namespace StoreApi;

/// <summary>
/// Describes the document as a whole: the API's narrative, tags and sign-in, and corrections to generated schemas
/// (discriminated unions as <c>oneOf</c>, enum types, framework problem-details descriptions).
/// </summary>
internal static class DocumentDescriptions
{
    private const string Overview = """
        The **Acme Store API** runs an online store: a catalogue of outdoor gear in eight currencies, stock levels in the warehouse, customers and their addresses, carts, orders, payments and refunds, shipments, product reviews and discount coupons. The storefront, the support desk and the warehouse all use it.

        ## An order in one minute

        A shopper browses **products** (public, no sign-in), puts variants in a **cart** (which holds their stock for 15 minutes) and asks for a **price quote** (held for 15 minutes in Redis). `OrdersController.Place` then turns the basket into an **order** in one request: it checks the rate limit and idempotency key, prices the lines, charges the payment method, decrements stock, writes the order's event history to MongoDB, and holds back the confirmation email and the fulfilment webhook. The warehouse then creates a **shipment**; a delivered order can be **refunded** in part or in full.

        An order moves `Pending` → `Paid` → `Processing` → `Shipped` → `Delivered`. It can be `Cancelled` before it ships and ends `Refunded` when fully refunded after delivery.

        ## Conventions

        - **Lists** are paged: pass `page` (from 1) and `pageSize` (1 to 100, default 25). Every list returns `{ items, page, pageSize, totalItems, totalPages }`. Lists can be filtered, searched with `q` and sorted with `sort`; a leading `-` reverses the order, as in `-price`.
        - **Errors** follow [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) problem details. Invalid input is a `400` with an `errors` object keyed by field (nested as `shippingAddress.city` or `items[0].sku`); `402` means the payment was declined, `409` the state does not allow it (out of stock, key reused, price moved), `422` the request is understood but breaks a business rule, and `429` too many orders in an hour.
        - **Money** is a decimal with at most two fraction digits (none for JPY), always next to its ISO 4217 currency. Prices include tax. **Dates** are ISO 8601; times are UTC.
        - **Idempotency:** send an `Idempotency-Key` header when placing an order, so a retry cannot charge twice.
        - **Deprecated operations** (`ProductsController.LegacySearch`, `StockController.LegacyLevel`) answer with `Deprecation` and `Sunset` headers and a `Link` to their replacement.

        ## Signing in

        Browsing the catalogue, reading reviews and registering are **public**. Everything else needs a session cookie. Sign in with `AuthController.Login` using any seeded user and the password `Demo123!`, or in development pick a persona with `AuthController.SwitchPersona`. Roles are the scopes an operation lists:

        | Role | Can |
        | --- | --- |
        | `admin` | Everything, including products, coupons and user roles |
        | `support` | Customers, orders, payments and refunds; place and cancel orders for customers |
        | `warehouse` | Stock levels, adjustments and shipments |
        | `customer` | Shop, keep a cart, place and follow **their own** orders |

        ## Data stores

        SQLite holds the store's tables. The demo can also run against optional **Redis** (price quotes, order rate limits), **MongoDB** (order event histories and product reviews as nested documents) and **DynamoDB** (idempotency keys); their operations (`OrdersController.Events`, the reviews) appear when the store is configured. **Preview** runs an operation for real and rolls everything back: SQL and MongoDB changes are undone, Redis and DynamoDB are read-only, and `CartsController.Quote` is marked `preview: false` because it writes to Redis.

        ## About this example

        This is a disposable example for Sendproof, with seeded data that resets when you delete its database. **Preview** shows the changes, notifications and database commands an operation would cause; **Send** commits them. No email, payment or carrier is ever contacted.
        """;

    /// <summary>Descriptions of enums that only appear as properties, where the generator drops their XML comment.</summary>
    private static readonly Dictionary<string, string> EnumDescriptions = new()
    {
        ["ShippingSpeed"] = "How quickly an order is delivered: `Standard`, `Express` or `Next day`.",
        ["CouponKind"] = "What a coupon takes off: a `Percentage` of the subtotal, a `FixedAmount`, or the shipping cost (`FreeShipping`). It is the `kind` that selects the variant of a coupon.",
        ["PaymentMethodKind"] ="How the customer pays. It is the `type` that selects the variant of a payment method."
    };

    private static readonly (string Name, string Description)[] Tags =
    [
        ("Authentication", "Sign in, sign out and switch between the seeded development personas (store admin, support agent, warehouse and customers). Sessions use a cookie."),
        ("Catalog", "Browse and search products and categories (public), read a product with its variants and prices in eight currencies, and let admins create and change them. Includes the deprecated v1 search."),
        ("Inventory", "Stock levels per variant, their movements and adjustments, and the reservations that hold stock for carts and orders. Includes the deprecated v1 stock level."),
        ("Customers", "Shopper profiles and their saved shipping and billing addresses. Registration is public; customers can only touch their own records."),
        ("Carts", "A customer's cart: add, change and remove lines (each holds stock for 15 minutes), and quote a price that is cached in Redis for 15 minutes."),
        ("Orders", "Place an order (idempotent, multi-store), list and read orders, cancel one before it ships, and read its event history from MongoDB."),
        ("Payments", "The payment taken for each order and the refunds made against it. Card, bank transfer and gift card payments are a union chosen by `type`."),
        ("Shipments", "Parcels handed to carriers, with their tracking scans. The warehouse creates a shipment for a paid order."),
        ("Reviews", "Customer reviews of products, kept as nested documents in MongoDB: ratings, helpful votes and staff replies. Only present when the demo runs with MongoDB."),
        ("Coupons", "Discount codes: a percentage, a fixed amount or free shipping, as a union chosen by `kind`. Check whether a code applies before ordering."),
        ("Users and roles", "The people who can sign in, the roles they hold and what each role allows. Admins change roles.")
    ];

    internal static Task TransformAsync(OpenApiDocument document, OpenApiDocumentTransformerContext context, CancellationToken cancellationToken)
    {
        document.Info.Title = "Acme Store API";
        document.Info.Version = "2.0.0";
        document.Info.Description = Overview;
        document.Info.Contact = new OpenApiContact { Name = "Acme Store Engineering", Email = "dev@acme-store.example", Url = new Uri("https://example.com/store") };
        document.Info.License = new OpenApiLicense { Name = "MIT", Identifier = "MIT", Url = new Uri("https://opensource.org/licenses/MIT") };
        document.ExternalDocs = new OpenApiExternalDocs { Description = "Sendproof, the workbench that serves this API", Url = new Uri("https://example.com/sendproof") };
        document.Components ??= new OpenApiComponents();
        document.Components.SecuritySchemes ??= new Dictionary<string, IOpenApiSecurityScheme>();
        document.Components.SecuritySchemes[OperationDescriptions.CookieScheme] = new OpenApiSecurityScheme
        {
            Type = SecuritySchemeType.ApiKey,
            In = ParameterLocation.Cookie,
            Name = ".AspNetCore.Cookies",
            Description = "Sign in with a password or a development persona. The browser keeps the session cookie. Operations list the roles they accept as scopes: `admin`, `support`, `warehouse` or `customer`."
        };
        document.Tags = Tags.Select(tag => new OpenApiTag { Name = tag.Name, Description = tag.Description }).ToHashSet();
        FixSchemas(document);
        return Task.CompletedTask;
    }

    /// <summary>
    /// Turns each discriminated union's <c>anyOf</c> into <c>oneOf</c> (exactly one variant applies), describes the
    /// discriminator property of every variant, types the enums and documents the framework problem-details schemas.
    /// </summary>
    private static void FixSchemas(OpenApiDocument document)
    {
        foreach (var (name, entry) in document.Components!.Schemas ?? new Dictionary<string, IOpenApiSchema>())
        {
            if (entry is not OpenApiSchema schema) continue;
            if (schema.Discriminator is { } discriminator && schema.AnyOf is { Count: > 0 } && schema.OneOf is not { Count: > 0 })
            {
                schema.OneOf = schema.AnyOf;
                schema.AnyOf = null;
                schema.Description ??= $"One of {string.Join(", ", discriminator.Mapping?.Keys ?? [])}, chosen by `{discriminator.PropertyName}`.";
                var mapping = discriminator.Mapping ?? new Dictionary<string, OpenApiSchemaReference>();
                foreach (var (value, target) in mapping)
                    if (document.Components.Schemas![target.Reference.Id!] is OpenApiSchema variant)
                        DescribeDiscriminator(variant, discriminator.PropertyName!, value);
            }
            if (schema.Enum is { Count: > 0 })
            {
                schema.Type ??= JsonSchemaType.String;
                // Nullable enum properties add null to the shared enum; a missing value is expressed on the property.
                var values = schema.Enum.Where(value => value is not null).ToList();
                if (values.Count != schema.Enum.Count) schema.Enum = values;
            }
            if (EnumDescriptions.TryGetValue(name, out var enumText)) schema.Description ??= enumText;
            if (name == "ProblemDetails" || name == "HttpValidationProblemDetails") DescribeProblemDetails(schema, name);
        }
    }

    private static void DescribeDiscriminator(OpenApiSchema variant, string property, string value)
    {
        if (variant.Properties is null || !variant.Properties.TryGetValue(property, out var entry) || entry is not OpenApiSchema discriminator) return;
        discriminator.Description ??= $"Always `{value}` for this variant. It tells the variants of the union apart.";
        variant.Required ??= new HashSet<string>();
        variant.Required.Add(property);
    }

    private static void DescribeProblemDetails(OpenApiSchema schema, string name)
    {
        schema.Description ??= name == "ProblemDetails"
            ? "An error in the RFC 9457 problem-details format."
            : "A request-validation error: problem details plus the failures per field.";
        foreach (var (property, text) in new Dictionary<string, string>
        {
            ["type"] = "A URI that identifies the kind of problem.",
            ["title"] = "A short summary of the problem. It does not change between occurrences.",
            ["status"] = "The HTTP status code of the response.",
            ["detail"] = "An explanation of this particular occurrence, written for the person using the API.",
            ["instance"] = "A URI that identifies this occurrence of the problem.",
            ["errors"] = "The validation failures: each key is the JSON name of a field (nested as `shippingAddress.city`), each value the messages for it."
        })
            if (schema.Properties?.TryGetValue(property, out var entry) == true && entry is OpenApiSchema member)
                member.Description ??= text;
    }
}
