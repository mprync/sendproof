using Microsoft.CodeAnalysis;

namespace Sendproof.Journeys.Generators;

/// <summary>
/// Generates the typed operations catalog (such as <c>StoreOperations</c>) from the app's minimal-API <c>Map*</c>
/// calls: one member per named endpoint with its request (route, query and header parameters and the handler's body
/// type) and its <c>Produces&lt;T&gt;</c> response type. Also records the file each journey class is declared in.
/// </summary>
[Generator(LanguageNames.CSharp)]
public sealed class OperationsGenerator : IIncrementalGenerator
{
    /// <inheritdoc />
    public void Initialize(IncrementalGeneratorInitializationContext context)
    {
        var endpoints = context.SyntaxProvider
            .CreateSyntaxProvider(static (node, _) => EndpointReader.IsCandidate(node), static (syntax, token) => EndpointReader.Read(syntax, token))
            .Where(static endpoint => endpoint is not null)
            .Select(static (endpoint, _) => endpoint!)
            .Collect();
        var journeys = context.SyntaxProvider
            .CreateSyntaxProvider(static (node, _) => JourneyClassReader.IsCandidate(node), static (syntax, token) => JourneyClassReader.Read(syntax, token))
            .Where(static journey => journey is not null)
            .Select(static (journey, _) => journey!)
            .Collect();
        var settings = context.CompilationProvider
            .Combine(context.AnalyzerConfigOptionsProvider)
            .Select(static (input, _) => GeneratorSettings.From(input.Left, input.Right.GlobalOptions));

        context.RegisterSourceOutput(endpoints.Combine(journeys).Combine(settings),
            static (output, input) => OperationsWriter.Write(output, input.Left.Left, input.Left.Right, input.Right));
    }
}
