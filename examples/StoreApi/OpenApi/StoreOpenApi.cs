using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

namespace StoreApi;

/// <summary>
/// Registers the OpenAPI 3.1 document of the Acme Store example. Most documentation comes from the XML comments on
/// the endpoint handlers and the contracts (the project generates its XML documentation file); three transformers add
/// what comments cannot express: security, examples, formats, lookups and the document's narrative.
/// </summary>
internal static class StoreOpenApi
{
    /// <summary>Configures the generated document.</summary>
    internal static void Configure(OpenApiOptions options)
    {
        options.OpenApiVersion = OpenApiSpecVersion.OpenApi3_1;
        // Polymorphic schemas are named after their base ("PaymentMethod") plus the suffix returned here ("PaymentMethodCard").
        options.CreateSchemaReferenceId = typeInfo => typeInfo.Type.Name switch
        {
            nameof(CardPayment) => "Card",
            nameof(BankTransferPayment) => "BankTransfer",
            nameof(GiftCardPayment) => "GiftCard",
            nameof(PercentageCoupon) => "Percentage",
            nameof(FixedAmountCoupon) => "FixedAmount",
            nameof(FreeShippingCoupon) => "FreeShipping",
            _ => OpenApiOptions.CreateDefaultSchemaReferenceId(typeInfo)
        };
        options.AddSchemaTransformer(SchemaDescriptions.TransformAsync);
        options.AddOperationTransformer(OperationDescriptions.TransformAsync);
        options.AddDocumentTransformer(DocumentDescriptions.TransformAsync);
    }
}
