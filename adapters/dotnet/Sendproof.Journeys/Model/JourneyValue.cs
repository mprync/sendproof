using System.Text.Json.Nodes;

namespace Sendproof.Journeys;

/// <summary>
/// A value in a definition (a literal, a ref or a matcher), kept unresolved until the documents are built, because
/// its JSON depends on where it goes: the app's JSON options for a request, the change capture's for a SQL column,
/// the BSON class map's for a MongoDB field.
/// </summary>
internal sealed class JourneyValue
{
    private readonly Func<JourneyValueContext, JsonNode?> _resolve;

    private JourneyValue(Func<JourneyValueContext, JsonNode?> resolve, IReadOnlyList<JourneyRefSource> references)
    {
        _resolve = resolve;
        References = references;
    }

    /// <summary>Gets the refs the value reads, so their order can be checked.</summary>
    internal IReadOnlyList<JourneyRefSource> References { get; }

    internal JsonNode? Resolve(JourneyValueContext context) => _resolve(context);

    internal static JourneyValue Literal(object? value, Type type) => new(context => context.Serialize(value, type), []);

    internal static JourneyValue Reference(JourneyRefSource source) =>
        new(context => JsonValue.Create(source.Expression(context.Json)), [source]);

    internal static JourneyValue Of(Func<JourneyValueContext, JsonNode?> resolve, IReadOnlyList<JourneyRefSource> references) =>
        new(resolve, references);
}
