using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Sendproof.Journeys.Testing;

/// <summary>
/// Compares JSON values the way a person reads them: numbers by value, IDs whatever their case, and MongoDB's
/// Extended JSON wrappers (<c>{"$oid": …}</c>, <c>{"$date": …}</c>) by what they wrap.
/// </summary>
internal static class JsonValues
{
    internal static bool Equal(JsonNode? expected, JsonNode? actual)
    {
        expected = Unwrap(expected);
        actual = Unwrap(actual);
        if (expected is null || actual is null)
        {
            return expected is null && actual is null;
        }

        if (Number(expected) is { } left && Number(actual) is { } right)
        {
            return left == right;
        }

        if (String(expected) is { } a && String(actual) is { } b)
        {
            return a == b || Guid.TryParse(a, out var first) && Guid.TryParse(b, out var second) && first == second;
        }

        return JsonNode.DeepEquals(expected, actual);
    }

    /// <summary>Whether a value has a matcher's <c>type</c>: date-time, uuid, string, number, integer, boolean or any.</summary>
    internal static bool HasType(string type, JsonNode? actual)
    {
        actual = Unwrap(actual);
        return type switch
        {
            "any" => true,
            "date-time" => String(actual) is { } text && DateTimeOffset.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.None, out _),
            "uuid" => String(actual) is { } id && Guid.TryParse(id, out _),
            "string" => String(actual) is not null,
            "number" => Number(actual) is not null,
            "integer" => Number(actual) is { } number && decimal.Truncate(number) == number,
            "boolean" => actual?.GetValueKind() is JsonValueKind.True or JsonValueKind.False,
            _ => false
        };
    }

    internal static string? String(JsonNode? value) => value is JsonValue text && text.TryGetValue<string>(out var s) ? s : null;

    private static decimal? Number(JsonNode? value) =>
        value?.GetValueKind() == JsonValueKind.Number && decimal.TryParse(value.ToJsonString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var number)
            ? number : null;

    private static JsonNode? Unwrap(JsonNode? value) => value is JsonObject { Count: 1 } wrapper &&
        wrapper.First() is { Key: "$oid" or "$date" or "$numberLong" or "$numberDecimal" or "$uuid" } inner ? inner.Value : value;
}
