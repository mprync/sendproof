using System.Reflection;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

namespace StoreApi;

/// <summary>
/// Adds to schemas what XML comments and data annotations cannot say: examples, formats, display hints for the
/// workbench, lookups, and the inline enums of the request bodies (inline, so the workbench can attach hints to them).
/// </summary>
internal static class SchemaDescriptions
{
    /// <summary>String properties of request bodies that take one of an enum's values, by declaring type and property.</summary>
    private static readonly Dictionary<(Type, string), (Type Enum, string[]? Only, bool Radio)> InlineEnums = new()
    {
        [(typeof(PlaceOrderRequest), nameof(PlaceOrderRequest.Currency))] = (typeof(Currency), null, false),
        [(typeof(PlaceOrderRequest), nameof(PlaceOrderRequest.ShippingSpeed))] = (typeof(ShippingSpeed), null, true),
        [(typeof(PriceQuoteRequest), nameof(PriceQuoteRequest.Currency))] = (typeof(Currency), null, false),
        [(typeof(PriceQuoteRequest), nameof(PriceQuoteRequest.ShippingSpeed))] = (typeof(ShippingSpeed), null, true),
        [(typeof(CreateProductRequest), nameof(CreateProductRequest.Currency))] = (typeof(Currency), null, false),
        [(typeof(UpdateProductRequest), nameof(UpdateProductRequest.Status))] = (typeof(ProductStatus), null, true),
        [(typeof(RefundRequest), nameof(RefundRequest.Currency))] = (typeof(Currency), null, false),
        [(typeof(RefundRequest), nameof(RefundRequest.Reason))] = (typeof(RefundReason), null, true),
        [(typeof(RegisterCustomerRequest), nameof(RegisterCustomerRequest.PreferredCurrency))] = (typeof(Currency), null, false),
        [(typeof(UpdateCustomerRequest), nameof(UpdateCustomerRequest.PreferredCurrency))] = (typeof(Currency), null, false),
        [(typeof(AddAddressRequest), nameof(AddAddressRequest.Kind))] = (typeof(AddressKind), null, true),
        [(typeof(CreateShipmentRequest), nameof(CreateShipmentRequest.Carrier))] = (typeof(Carrier), null, false),
        [(typeof(AdjustStockRequest), nameof(AdjustStockRequest.Reason))] = (typeof(StockReason), ["Received", "Returned", "Adjustment", "Damaged"], true),
        [(typeof(FixedAmountCoupon), nameof(FixedAmountCoupon.Currency))] = (typeof(Currency), null, false),
        [(typeof(CardPayment), nameof(CardPayment.Brand))] = (typeof(CardBrand), null, true)
    };

    /// <summary>Properties that are ID or SKU pickers: the lookup that lists the real records, and the label the picker shows.</summary>
    private static readonly Dictionary<(Type, string), (string Title, Func<JsonObject> Lookup)> Lookups = new()
    {
        [(typeof(PlaceOrderRequest), nameof(PlaceOrderRequest.CustomerId))] = ("Customer", OperationDescriptions.CustomerLookup),
        [(typeof(AddReviewRequest), nameof(AddReviewRequest.CustomerId))] = ("Customer", OperationDescriptions.CustomerLookup),
        [(typeof(CreateProductRequest), nameof(CreateProductRequest.CategoryId))] = ("Category", OperationDescriptions.CategoryLookup),
        [(typeof(UpdateProductRequest), nameof(UpdateProductRequest.CategoryId))] = ("Category", OperationDescriptions.CategoryLookup),
        [(typeof(CreateCategoryRequest), nameof(CreateCategoryRequest.ParentId))] = ("Parent category", OperationDescriptions.CategoryLookup),
        [(typeof(CreateShipmentRequest), nameof(CreateShipmentRequest.OrderId))] = ("Order", OperationDescriptions.PaidOrderLookup),
        [(typeof(OrderLineRequest), nameof(OrderLineRequest.Sku))] = ("SKU", OperationDescriptions.StockLookup),
        [(typeof(AddCartItemRequest), nameof(AddCartItemRequest.Sku))] = ("SKU", OperationDescriptions.StockLookup),
        [(typeof(QuoteLineRequest), nameof(QuoteLineRequest.Sku))] = ("SKU", OperationDescriptions.StockLookup)
    };

    /// <summary>Value-type properties the endpoints reject when missing (their CLR defaults are invalid), so the schema must require them.</summary>
    private static readonly Dictionary<Type, string[]> Required = new()
    {
        [typeof(PlaceOrderRequest)] = ["customerId", "items", "shippingAddress", "payment"],
        [typeof(CreateProductRequest)] = ["name", "slug", "brand", "description", "categoryId", "price", "currency", "variants"],
        [typeof(AdjustStockRequest)] = ["delta", "reason"],
        [typeof(RefundRequest)] = ["amount", "currency", "reason"],
        [typeof(CreateShipmentRequest)] = ["orderId", "carrier"],
        [typeof(AddReviewRequest)] = ["rating", "title", "body", "customerId"],
        [typeof(PriceQuoteRequest)] = ["items"],
        [typeof(AddCartItemRequest)] = ["sku"],
        [typeof(RedeemCouponRequest)] = ["count"],
        [typeof(AddAddressRequest)] = ["label", "address"],
        [typeof(Address)] = ["recipient", "line1", "city", "postalCode", "country"]
    };

    internal static Task TransformAsync(OpenApiSchema schema, OpenApiSchemaTransformerContext context, CancellationToken cancellationToken)
    {
        var type = context.JsonTypeInfo.Type;
        if (context.JsonPropertyInfo is null)
        {
            DescribeType(schema, type);
            return Task.CompletedTask;
        }
        if (context.JsonPropertyInfo.AttributeProvider is not PropertyInfo property) return Task.CompletedTask;
        // An enum-typed property shares its schema with the enum itself: adjusting it here would change every use.
        // The value descriptions are the same for every use, so they are the one thing added here (the shared
        // schema may be produced only through a property).
        if (type.IsEnum || Nullable.GetUnderlyingType(type)?.IsEnum == true)
        {
            if (EnumDescriptions.For(type) is { } descriptions) SetExtension(schema, EnumDescriptions.Extension, descriptions);
            return Task.CompletedTask;
        }
        DescribeProperty(schema, property, type);
        return Task.CompletedTask;
    }

    /// <summary>Type-level additions: examples, the description of generic pages and required properties.</summary>
    private static void DescribeType(OpenApiSchema schema, Type type)
    {
        if (type.IsEnum && schema.Type is null) schema.Type = JsonSchemaType.String;
        if (EnumDescriptions.For(type) is { } descriptions) SetExtension(schema, EnumDescriptions.Extension, descriptions);
        if (type.IsGenericType && type.GetGenericTypeDefinition() == typeof(PagedList<>))
        {
            var item = type.GetGenericArguments()[0].Name;
            schema.Description = $"One page of {item} items, with the paging metadata needed to fetch the other pages.";
        }
        var example = Examples.For(type);
        if (example is not null) schema.Examples = [example];
        if (Required.TryGetValue(type, out var required))
        {
            schema.Required ??= new HashSet<string>();
            foreach (var name in required) schema.Required.Add(name);
        }
    }

    /// <summary>Property-level additions: formats, patterns, lookups, inline enums and the workbench's layout hints.</summary>
    private static void DescribeProperty(OpenApiSchema schema, PropertyInfo property, Type type)
    {
        var plain = Nullable.GetUnderlyingType(type) ?? type;
        if (plain == typeof(decimal))
        {
            schema.Format = "decimal";
            if (property.Name is "Price" or "Amount" or "AmountOff" && schema.MultipleOf is null) schema.MultipleOf = 0.01m;
        }
        if (plain == typeof(string))
        {
            switch (property.Name)
            {
                case "Country": schema.Pattern ??= "^[A-Z]{2}$"; schema.MinLength ??= 2; schema.MaxLength ??= 2; break;
                case "Email": schema.Format = "email"; break;
                case "Password": schema.Format = "password"; schema.WriteOnly = true; break;
                case "Sku": schema.Pattern ??= "^[A-Z0-9-]{6,24}$"; break;
            }
        }
        var key = (property.DeclaringType!, property.Name);
        if (Lookups.TryGetValue(key, out var lookup))
        {
            schema.Title = lookup.Title;
            SetExtension(schema, "x-lookup", lookup.Lookup());
        }
        if (InlineEnums.TryGetValue(key, out var inline))
        {
            var values = inline.Only ?? [.. EnumDescriptions.WireValues(inline.Enum)];
            schema.Enum = values.Select(value => (JsonNode)JsonValue.Create(value)!).ToList();
            if (EnumDescriptions.For(inline.Enum) is { } descriptions) SetExtension(schema, EnumDescriptions.Extension, descriptions);
            if (inline.Radio) SetExtension(schema, "x-sendproof-visible", JsonValue.Create(true)!);
        }
        DescribeLayout(schema, property);
    }

    /// <summary>The order and refund forms: amount-and-currency pairs, rows and the fields the form shows by default.</summary>
    private static void DescribeLayout(OpenApiSchema schema, PropertyInfo property)
    {
        var owner = property.DeclaringType;
        switch (owner?.Name, property.Name)
        {
            case (nameof(CreateProductRequest), nameof(CreateProductRequest.Price)):
                SetExtension(schema, "x-currency-field", JsonValue.Create("currency")!);
                SetExtension(schema, "x-sendproof-row", JsonValue.Create("price")!);
                SetExtension(schema, "x-sendproof-type-label", JsonValue.Create("decimal · ≥ 0.01")!);
                break;
            case (nameof(RefundRequest), nameof(RefundRequest.Amount)):
                SetExtension(schema, "x-currency-field", JsonValue.Create("currency")!);
                SetExtension(schema, "x-sendproof-row", JsonValue.Create("refund")!);
                SetExtension(schema, "x-sendproof-type-label", JsonValue.Create("decimal · ≥ 0.01")!);
                break;
            case (nameof(FixedAmountCoupon), nameof(FixedAmountCoupon.AmountOff)):
                SetExtension(schema, "x-currency-field", JsonValue.Create("currency")!);
                SetExtension(schema, "x-sendproof-row", JsonValue.Create("discount")!);
                break;
            case (nameof(PlaceOrderRequest), nameof(PlaceOrderRequest.QuoteId)):
                // Optional and left out of the form until it is wanted, so the workbench shows its "add" chip.
                schema.Title = "Price quote";
                break;
            case (nameof(PlaceOrderRequest), nameof(PlaceOrderRequest.CouponCode) or nameof(PlaceOrderRequest.Note)):
            case (nameof(PlaceOrderRequest), nameof(PlaceOrderRequest.Currency)):
            case (nameof(OrderLineRequest), nameof(OrderLineRequest.Quantity)):
            case (nameof(CreateShipmentRequest), nameof(CreateShipmentRequest.EstimatedDelivery)):
            case (nameof(Address), nameof(Address.Line2)):
                SetExtension(schema, "x-sendproof-visible", JsonValue.Create(true)!);
                break;
            case (nameof(CreateProductRequest), nameof(CreateProductRequest.Tags)):
                schema.Items = new OpenApiSchema { Type = JsonSchemaType.String, MaxLength = 30, Description = "One tag, such as `waterproof`." };
                break;
            case (nameof(UpdateProductRequest), nameof(UpdateProductRequest.Tags)):
                schema.Items = new OpenApiSchema { Type = JsonSchemaType.String, MaxLength = 30, Description = "One tag, such as `waterproof`." };
                break;
        }
    }

    // Display hints are optional and do not modify OpenAPI validation rules.
    private static void SetExtension(OpenApiSchema schema, string name, JsonNode value)
    {
        schema.Extensions ??= new Dictionary<string, IOpenApiExtension>();
        schema.Extensions[name] = new JsonNodeExtension(value);
    }
}
