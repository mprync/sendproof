using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Sendproof.Journeys.Testing;

/// <summary>
/// Evaluates the runtime expressions inside a value: a string that is a whole expression becomes its value, and
/// <c>{$expression}</c> inside a longer string is replaced by its text, as Arazzo payloads and Redis keys use them.
/// </summary>
internal static partial class Interpolation
{
    internal static JsonNode? Apply(JsonNode? value, ExpressionContext context) => value switch
    {
        JsonObject properties => new JsonObject(properties.Select(property => KeyValuePair.Create(property.Key, Apply(property.Value, context)))),
        JsonArray items => new JsonArray([.. items.Select(item => Apply(item, context))]),
        JsonValue text when text.TryGetValue<string>(out var s) && ExpressionContext.IsExpression(s) => context.Evaluate(s),
        JsonValue text when text.TryGetValue<string>(out var s) && s.Contains("{$", StringComparison.Ordinal) =>
            JsonValue.Create(Embedded().Replace(s, match => Text(context.Evaluate(match.Groups[1].Value)))),
        _ => value?.DeepClone()
    };

    /// <summary>A value as it reads in a URL, a header or a key: strings without quotes, anything else as JSON.</summary>
    internal static string Text(JsonNode? value) => value switch
    {
        null => "",
        JsonValue text when text.TryGetValue<string>(out var s) => s,
        _ => value.ToJsonString()
    };

    [GeneratedRegex(@"\{(\$[^}]+)\}")]
    private static partial Regex Embedded();
}
