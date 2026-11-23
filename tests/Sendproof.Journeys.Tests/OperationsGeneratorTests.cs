using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Sendproof.Journeys.Generators;
using Xunit;

namespace Sendproof.Journeys.Tests;

/// <summary>The operations generator, run on a small app through Roslyn's generator driver.</summary>
public sealed class OperationsGeneratorTests
{
    private const string App = """
        using Microsoft.AspNetCore.Builder;
        using Microsoft.AspNetCore.Http;
        using Microsoft.AspNetCore.Mvc;
        using Sendproof.Journeys;

        [assembly: JourneyOperations("ShopOperations")]

        namespace Shop;

        public sealed class Order { public System.Guid Id { get; set; } }
        public sealed class PlaceOrder { public string Sku { get; set; } = ""; }
        public sealed class Clock { }

        public static class ShopEndpoints
        {
            public static void Map(WebApplication app)
            {
                var orders = app.MapGroup("/api/{tenant}/orders").WithTags("Orders");
                orders.MapPost("/", Place).WithName("OrdersController.Place").Produces<Order>(StatusCodes.Status201Created).ProducesProblem(409);
                orders.MapGet("/{id:guid}", (System.Guid id, string tenant, int? page, [FromHeader(Name = "X-Trace")] string? trace) => Results.Ok())
                    .WithName("OrdersController.Get").Produces<Order>();
                app.MapDelete("/api/cache", Purge);
            }

            static IResult Place(PlaceOrder request, string tenant, Clock clock, System.Threading.CancellationToken cancellationToken) => Results.Ok();

            static IResult Purge() => Results.NoContent();
        }
        """;

    [Fact]
    public void Named_endpoints_become_typed_operations_with_their_parameters_body_and_response()
    {
        var (source, diagnostics, errors) = Run(App);

        Assert.Empty(errors);
        Assert.Contains("internal static partial class ShopOperations", source);
        Assert.Contains("internal static class Orders", source);
        Assert.Contains("JourneyOperation<PlaceRequest, global::Shop.Order> Place = new(\"OrdersController.Place\", \"POST\");", source);
        Assert.Contains("[global::Microsoft.AspNetCore.Mvc.FromRoute(Name = \"tenant\")] public string Tenant { get; set; } = default!;", source);
        // The first complex parameter is the body; the service class after it is not.
        Assert.Contains("[global::Microsoft.AspNetCore.Mvc.FromBody] public global::Shop.PlaceOrder Body { get; set; } = default!;", source);
        Assert.DoesNotContain("Clock", source);
        Assert.Contains("JourneyOperation<GetRequest, global::Shop.Order> Get = new(\"OrdersController.Get\", \"GET\");", source);
        Assert.Contains("[global::Microsoft.AspNetCore.Mvc.FromRoute(Name = \"id\")] public global::System.Guid Id { get; set; }", source);
        Assert.Contains("[global::Microsoft.AspNetCore.Mvc.FromQuery(Name = \"page\")] public int? Page { get; set; }", source);
        Assert.Contains("[global::Microsoft.AspNetCore.Mvc.FromHeader(Name = \"X-Trace\")] public string? Trace { get; set; }", source);

        // An endpoint without a name is in the catalog under its action, with a warning.
        var warning = Assert.Single(diagnostics);
        Assert.Equal("SPJ001", warning.Id);
        Assert.Equal(DiagnosticSeverity.Warning, warning.Severity);
        Assert.Contains("DELETE /api/cache has no WithName", warning.GetMessage());
        Assert.Contains("JourneyOperation<PurgeRequest, object> Purge = new(\"Shop.Purge\", \"DELETE\");", source);
    }

    [Fact]
    public void Without_Sendproof_Journeys_nothing_is_generated()
    {
        var (source, diagnostics, _) = Run(App.Replace("using Sendproof.Journeys;", "").Replace("[assembly: JourneyOperations(\"ShopOperations\")]", ""), referenceJourneys: false);

        Assert.Equal("", source);
        Assert.Empty(diagnostics);
    }

    private static (string Source, IReadOnlyList<Diagnostic> Diagnostics, IReadOnlyList<Diagnostic> Errors) Run(string code, bool referenceJourneys = true)
    {
        var references = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!).Split(Path.PathSeparator)
            .Where(path => referenceJourneys || !Path.GetFileName(path).StartsWith("Sendproof.Journeys", StringComparison.Ordinal))
            .Select(path => MetadataReference.CreateFromFile(path));
        var compilation = CSharpCompilation.Create("Shop", [CSharpSyntaxTree.ParseText(code, path: "/src/Shop/ShopEndpoints.cs")], references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, nullableContextOptions: NullableContextOptions.Enable));
        var driver = CSharpGeneratorDriver.Create(new OperationsGenerator()).RunGeneratorsAndUpdateCompilation(compilation, out var output, out var diagnostics);
        var source = string.Concat(driver.GetRunResult().GeneratedTrees.Select(tree => tree.ToString()));
        return (source, diagnostics, output.GetDiagnostics().Where(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error).ToList());
    }
}
