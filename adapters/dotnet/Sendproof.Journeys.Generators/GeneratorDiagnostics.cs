using Microsoft.CodeAnalysis;

namespace Sendproof.Journeys.Generators;

/// <summary>The warnings the operations generator reports.</summary>
internal static class GeneratorDiagnostics
{
    public static readonly DiagnosticDescriptor Unnamed = new(
        "SPJ001",
        "Endpoint has no name",
        "{0} {1} has no WithName, so its OpenAPI operation has no operationId; it is in the operations catalog as {2}, but a journey step can't call it until it has a name",
        "Sendproof.Journeys",
        DiagnosticSeverity.Warning,
        isEnabledByDefault: true);

    public static readonly DiagnosticDescriptor Duplicate = new(
        "SPJ002",
        "Two operations have one catalog name",
        "{0} and {1} both become {2} in the operations catalog; {1} is left out. Rename one of them with WithName.",
        "Sendproof.Journeys",
        DiagnosticSeverity.Warning,
        isEnabledByDefault: true);
}
