using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Authorization.Infrastructure;
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

namespace StoreApi;

/// <summary>
/// Adds to each operation what its XML comments cannot say: the cookie security requirement and roles, the
/// 401 and 403 responses, deprecation, paging and sorting constraints, lookups for ID parameters and error examples.
/// </summary>
internal static class OperationDescriptions
{
    internal const string CookieScheme = "cookieAuth";

    /// <summary>Lookups that let the workbench offer real records for an ID parameter, keyed by the parameter name and route.</summary>
    private static readonly (string RouteContains, string Parameter, JsonObject Lookup)[] Lookups =
    [
        ("/products/{id}", "id", ProductLookup()),
        ("/products/{productId}", "productId", ProductLookup()),
        ("/orders/{id}", "id", OrderLookup()),
        ("/customers/{id}", "id", CustomerLookup()),
        ("/customers/{customerId}", "customerId", CustomerLookup()),
        ("/payments/{id}", "id", Lookup("/api/v2/payments?pageSize=50", "id", "orderNumber", "methodDisplay", "status")),
        ("/shipments/{id}", "id", Lookup("/api/v2/shipments?pageSize=50", "id", "trackingNumber", "orderNumber", "status")),
        ("/stock/{sku}", "sku", StockLookup()),
        ("/users/{id}", "id", Lookup("/api/v2/users?pageSize=100", "id", "name", "email")),
        ("/coupons/{code}", "code", Lookup("/api/v2/coupons?pageSize=100", "code", "code", "description")),
        ("", "customerId", CustomerLookup()),
        ("", "orderId", OrderLookup()),
        ("", "categoryId", CategoryLookup()),
        ("", "sku", StockLookup())
    ];

    internal static Task TransformAsync(OpenApiOperation operation, OpenApiOperationTransformerContext context, CancellationToken cancellationToken)
    {
        var metadata = context.Description.ActionDescriptor.EndpointMetadata;
        DescribeSecurity(operation, context, metadata);
        if (metadata.OfType<ObsoleteAttribute>().Any()) operation.Deprecated = true;
        DescribeDeprecation(operation, metadata.OfType<DeprecationMetadata>().FirstOrDefault());
        DescribeParameters(operation, Regex.Replace(context.Description.RelativePath ?? "", @"\{(\w+)[^}]*\}", "{$1}"), metadata.OfType<SortKeysMetadata>().FirstOrDefault());
        AddErrorExamples(operation);
        return Task.CompletedTask;
    }

    /// <summary>
    /// Adds the cookie security requirement, role names and the 401 and 403 responses of every
    /// endpoint that requires authorization. Role alternatives become alternative requirements.
    /// </summary>
    private static void DescribeSecurity(OpenApiOperation operation, OpenApiOperationTransformerContext context, IList<object> metadata)
    {
        var policies = metadata.OfType<AuthorizationPolicy>().ToList();
        if (!metadata.OfType<IAuthorizeData>().Any() && policies.Count == 0) return;
        var roles = policies.SelectMany(policy => policy.Requirements.OfType<RolesAuthorizationRequirement>())
            .SelectMany(requirement => requirement.AllowedRoles).Distinct().ToList();
        var scheme = new OpenApiSecuritySchemeReference(CookieScheme, context.Document);
        operation.Security = roles.Count == 0
            ? [new OpenApiSecurityRequirement { [scheme] = [] }]
            : roles.Select(role => new OpenApiSecurityRequirement { [scheme] = [role] }).ToList();
        operation.Responses ??= new OpenApiResponses();
        operation.Responses.TryAdd("401", Problem(context.Document, "Not signed in. Sign in with `AuthController.Login` or switch persona, then retry."));
        if (roles.Count > 0)
            operation.Responses.TryAdd("403", Problem(context.Document, $"Signed in without the {string.Join(" or ", roles)} role."));
    }

    private static OpenApiResponse Problem(OpenApiDocument? document, string description) => new()
    {
        Description = description,
        Content = new Dictionary<string, OpenApiMediaType>
        {
            ["application/problem+json"] = new() { Schema = new OpenApiSchemaReference("ProblemDetails", document) }
        }
    };

    /// <summary>
    /// Publishes how a deprecated operation is retired: <c>x-replaced-by</c> (a list of replacement operations, each
    /// with an optional parameter mapping as in an OpenAPI Link object) and <c>x-sunset</c> (the removal date).
    /// </summary>
    private static void DescribeDeprecation(OpenApiOperation operation, DeprecationMetadata? retirement)
    {
        if (retirement is null) return;
        var replacements = new JsonArray();
        foreach (var replacement in retirement.Replacements)
        {
            var entry = new JsonObject { ["operationId"] = replacement.OperationId };
            if (replacement.Parameters is { Count: > 0 } map)
            {
                var parameters = new JsonObject();
                foreach (var (name, expression) in map) parameters[name] = expression;
                entry["parameters"] = parameters;
            }
            entry["description"] = replacement.Description;
            replacements.Add(entry);
        }
        operation.Extensions ??= new Dictionary<string, IOpenApiExtension>();
        operation.Extensions["x-replaced-by"] = new JsonNodeExtension(replacements);
        operation.Extensions["x-sunset"] = new JsonNodeExtension(JsonValue.Create(retirement.Sunset.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture))!);
    }

    /// <summary>Sets paging limits, the allowed sort values and ID lookups on the operation's parameters.</summary>
    private static void DescribeParameters(OpenApiOperation operation, string route, SortKeysMetadata? sortKeys)
    {
        foreach (var parameter in operation.Parameters?.OfType<OpenApiParameter>() ?? [])
        {
            // The header's name is not a C# identifier, so its XML comment cannot be matched by name.
            if (parameter.Name == "Idempotency-Key")
                parameter.Description ??= "A unique key for this request, up to 128 characters. Generate a UUID for each new order; repeating the request with the same key returns the original order instead of charging twice. The key is remembered in SQL and, when configured, in DynamoDB.";
            if (parameter.Schema is not OpenApiSchema schema) continue;
            switch (parameter.Name)
            {
                case "page":
                    schema.Minimum = "1";
                    schema.Default = JsonValue.Create(1);
                    break;
                case "pageSize":
                    schema.Minimum = "1";
                    schema.Maximum = "100";
                    schema.Default = JsonValue.Create(EndpointSupport.DefaultPageSize);
                    break;
                case "q":
                    schema.MaxLength = 100;
                    break;
                case "country":
                    schema.Pattern = "^[A-Z]{2}$";
                    break;
                case "sort" when sortKeys is not null:
                    schema.Enum = sortKeys.Values.Select(value => (JsonNode)JsonValue.Create(value)!).ToList();
                    if (sortKeys.Descriptions is { Count: > 0 } descriptions)
                    {
                        var map = new JsonObject();
                        foreach (var value in sortKeys.Values)
                            if (descriptions.TryGetValue(value, out var text)) map[value] = text;
                        schema.Extensions ??= new Dictionary<string, IOpenApiExtension>();
                        schema.Extensions[EnumDescriptions.Extension] = new JsonNodeExtension(map);
                    }
                    break;
                case "minAmount" or "maxAmount" or "minTotal" or "maxTotal" or "minPrice" or "maxPrice" or "subtotal":
                    schema.Minimum = "0";
                    break;
                case "minRating":
                    schema.Minimum = "1";
                    schema.Maximum = "5";
                    schema.Default = JsonValue.Create(1);
                    break;
            }
            var lookup = Lookups.FirstOrDefault(entry => entry.Parameter == parameter.Name && (entry.RouteContains == "" || route.Contains(entry.RouteContains.TrimStart('/'))));
            if (lookup.Lookup is not null)
            {
                schema.Extensions ??= new Dictionary<string, IOpenApiExtension>();
                schema.Extensions["x-lookup"] = new JsonNodeExtension(lookup.Lookup.DeepClone());
            }
        }
    }

    /// <summary>Adds an example body to every problem response, so the workbench and readers see the shape.</summary>
    private static void AddErrorExamples(OpenApiOperation operation)
    {
        foreach (var (code, response) in operation.Responses ?? [])
        {
            if (response is not OpenApiResponse { Content: { } content }) continue;
            foreach (var media in content.Values)
            {
                var id = (media.Schema as OpenApiSchemaReference)?.Reference?.Id;
                media.Example ??= id switch
                {
                    "HttpValidationProblemDetails" => ValidationExample(),
                    "ProblemDetails" => ProblemExample(code),
                    _ => null
                };
            }
        }
    }

    private static JsonNode ValidationExample() => new JsonObject
    {
        ["type"] = "https://tools.ietf.org/html/rfc9110#section-15.5.1",
        ["title"] = "One or more validation errors occurred.",
        ["status"] = 400,
        ["errors"] = new JsonObject
        {
            ["items[0].quantity"] = new JsonArray("The quantity must be between 1 and 20."),
            ["shippingAddress.postalCode"] = new JsonArray("The PostalCode field is required.")
        }
    };

    private static JsonNode? ProblemExample(string code) => code switch
    {
        "401" => Example("https://tools.ietf.org/html/rfc9110#section-15.5.2", "Unauthorized", 401, "You are not signed in."),
        "403" => Example("https://tools.ietf.org/html/rfc9110#section-15.5.4", "Forbidden", 403, "Your role may not perform this operation."),
        "402" => Example("https://tools.ietf.org/html/rfc9110#section-15.5.3", "Payment declined", 402, "Visa •••• 0002 was declined by the card issuer. Try another payment method."),
        "404" => Example("https://tools.ietf.org/html/rfc9110#section-15.5.5", "Not found", 404, "No order exists with ID 7d2e41a0-5c1b-4e8f-a3d2-6b0e19c49f13."),
        "409" => Example("https://tools.ietf.org/html/rfc9110#section-15.5.10", "Conflict", 409, "Only 2 of TRL-JKT-BLK-M are available; you asked for 5."),
        "422" => Example("https://tools.ietf.org/html/rfc9110#section-15.5.21", "Business rule violated", 422, "Only 24.50 EUR is left to refund; you asked for 80.00."),
        "429" => Example("https://tools.ietf.org/html/rfc6585#section-4", "Too many orders", 429, "liam.reseller@acme.dev already placed 10 orders this hour. Try again later."),
        _ => null
    };

    private static JsonObject Example(string type, string title, int status, string detail) =>
        new() { ["type"] = type, ["title"] = title, ["status"] = status, ["detail"] = detail };

    private static JsonObject Lookup(string url, string valueField, string labelField, string detailField, string? statusField = null)
    {
        var lookup = new JsonObject { ["url"] = url, ["valueField"] = valueField, ["labelField"] = labelField, ["detailField"] = detailField };
        if (statusField is not null) lookup["statusField"] = statusField;
        return lookup;
    }

    /// <summary>The lookup that lists the customers an order can be placed for.</summary>
    internal static JsonObject CustomerLookup() => Lookup("/api/v2/customers?pageSize=100", "id", "name", "email", "tier");

    /// <summary>The lookup that lists products by name.</summary>
    internal static JsonObject ProductLookup() => Lookup("/api/v2/products?pageSize=100&sort=name", "id", "name", "brand", "status");

    /// <summary>The lookup that lists categories.</summary>
    internal static JsonObject CategoryLookup() => Lookup("/api/v2/categories", "id", "name", "slug");

    /// <summary>The lookup that lists recent orders by number.</summary>
    internal static JsonObject OrderLookup() => Lookup("/api/v2/orders?pageSize=50", "id", "number", "placedAt", "status");

    /// <summary>The lookup that lists orders paid and waiting to ship.</summary>
    internal static JsonObject PaidOrderLookup() => Lookup("/api/v2/orders?status=Paid&pageSize=100", "id", "number", "placedAt", "status");

    /// <summary>The lookup that lists variants by SKU, from the stock list.</summary>
    internal static JsonObject StockLookup() => Lookup("/api/v2/stock?pageSize=100", "sku", "name", "sku");
}
