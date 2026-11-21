using System.Reflection;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

namespace TreasuryApi;

/// <summary>
/// Adds to schemas what XML comments and data annotations cannot say: examples, formats, display hints for the
/// workbench, and the enums of the payment request (inline, so the workbench can attach hints to them).
/// </summary>
internal static class SchemaDescriptions
{
    private const string IbanPattern = "^[A-Z]{2}[0-9]{2}[A-Z0-9 ]{11,32}$";
    private const string BicPattern = "^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$";

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

    /// <summary>Type-level additions: examples and the description of generic pages.</summary>
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
        if (type == typeof(CreatePaymentRequest))
        {
            // The endpoint rejects missing values (their CLR defaults are invalid).
            schema.Required ??= new HashSet<string>();
            schema.Required.Add("amount");
            schema.Required.Add("valueDate");
        }
    }

    /// <summary>Property-level additions: formats, patterns, lookups and the payment form's layout hints.</summary>
    private static void DescribeProperty(OpenApiSchema schema, PropertyInfo property, Type type)
    {
        var plain = Nullable.GetUnderlyingType(type) ?? type;
        if (plain == typeof(decimal))
        {
            schema.Format = "decimal";
            if (property.Name is "Amount" or "BaseAmount" && schema.MultipleOf is null) schema.MultipleOf = 0.01m;
        }
        if (plain == typeof(string))
        {
            switch (property.Name)
            {
                case "Iban": schema.Pattern ??= IbanPattern; schema.MaxLength ??= 42; break;
                case "Bic": schema.Pattern ??= BicPattern; break;
                case "Country" or "EntityCountry": schema.Pattern ??= "^[A-Z]{2}$"; schema.MinLength ??= 2; schema.MaxLength ??= 2; break;
                case "Email" or "ContactEmail": schema.Format = "email"; break;
                case "Password": schema.Format = "password"; schema.WriteOnly = true; break;
            }
        }
        if (property.DeclaringType == typeof(CreatePaymentRequest) || property.DeclaringType == typeof(UpdatePaymentRequest))
            DescribePaymentRequest(schema, property);
        if (property.DeclaringType == typeof(CreateAccountRequest) && property.Name == nameof(CreateAccountRequest.Bic))
            schema.Examples = [JsonValue.Create("AIBKIE2D")!];
    }

    /// <summary>
    /// The payment form: lookups for the two accounts, two decimal places for the amount, and inline enums for the
    /// currency and priority so the workbench can show them as a menu and as segmented buttons.
    /// </summary>
    private static void DescribePaymentRequest(OpenApiSchema schema, PropertyInfo property)
    {
        switch (property.Name)
        {
            case nameof(CreatePaymentRequest.DebitAccountId):
                schema.Title = "Debit account";
                SetExtension(schema, "x-lookup", OperationDescriptions.DebitAccountLookup());
                break;
            case nameof(CreatePaymentRequest.CounterpartyId):
                schema.Title = "Counterparty";
                SetExtension(schema, "x-lookup", OperationDescriptions.CounterpartyLookup());
                break;
            case nameof(CreatePaymentRequest.Amount):
                SetExtension(schema, "x-currency-field", JsonValue.Create("currency")!);
                SetExtension(schema, "x-sendproof-row", JsonValue.Create("payment-details")!);
                SetExtension(schema, "x-sendproof-type-label", JsonValue.Create("decimal · ≥ 0.01")!);
                break;
            case nameof(CreatePaymentRequest.ValueDate):
                schema.Title = "Value date";
                SetExtension(schema, "x-sendproof-row", JsonValue.Create("payment-details")!);
                break;
            case nameof(CreatePaymentRequest.Currency):
                schema.Enum = Enum.GetNames<Currency>().Select(name => (JsonNode)JsonValue.Create(name)!).ToList();
                SetExtension(schema, EnumDescriptions.Extension, EnumDescriptions.For(typeof(Currency))!);
                break;
            case nameof(CreatePaymentRequest.Priority):
                schema.Enum = [JsonValue.Create("Normal")!, JsonValue.Create("Urgent")!, JsonValue.Create("Same day")!];
                SetExtension(schema, EnumDescriptions.Extension, EnumDescriptions.For(typeof(Priority))!);
                SetExtension(schema, "x-sendproof-visible", JsonValue.Create(true)!);
                break;
            case nameof(CreatePaymentRequest.ChargeBearer):
                schema.Enum = [JsonValue.Create("SHA")!, JsonValue.Create("OUR")!, JsonValue.Create("BEN")!];
                break;
            case nameof(CreatePaymentRequest.Reference):
                SetExtension(schema, "x-sendproof-visible", JsonValue.Create(true)!);
                break;
            case nameof(CreatePaymentRequest.RemittanceLines):
                schema.Items = new OpenApiSchema { Type = JsonSchemaType.String, MaxLength = 140, Description = "One line of free text for the beneficiary." };
                SetExtension(schema, "x-sendproof-visible", JsonValue.Create(true)!);
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
