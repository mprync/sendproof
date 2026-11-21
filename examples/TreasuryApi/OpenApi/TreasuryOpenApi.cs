using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

namespace TreasuryApi;

/// <summary>
/// Registers the OpenAPI 3.1 document of the Treasury example. Most documentation comes from the XML comments on
/// the endpoint handlers and the contracts (the project generates its XML documentation file); three transformers add
/// what comments cannot express: security, examples, formats, lookups and the document's narrative.
/// </summary>
internal static class TreasuryOpenApi
{
    /// <summary>Configures the generated document.</summary>
    internal static void Configure(OpenApiOptions options)
    {
        options.OpenApiVersion = OpenApiSpecVersion.OpenApi3_1;
        // Polymorphic schemas are named after their base ("FxDeal") plus the suffix returned here.
        options.CreateSchemaReferenceId = typeInfo => typeInfo.Type.Name switch
        {
            nameof(SpotFxDeal) => "Spot",
            nameof(ForwardFxDeal) => "Forward",
            nameof(IbanBankDetails) => "Iban",
            nameof(UsAchBankDetails) => "UsAch",
            nameof(SwiftBankDetails) => "Swift",
            _ => OpenApiOptions.CreateDefaultSchemaReferenceId(typeInfo)
        };
        options.AddSchemaTransformer(SchemaDescriptions.TransformAsync);
        options.AddOperationTransformer(OperationDescriptions.TransformAsync);
        options.AddDocumentTransformer(DocumentDescriptions.TransformAsync);
    }
}
