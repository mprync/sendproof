using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Sendproof.Journeys.Testing;

/// <summary>
/// Compares what a step wrote with its expectations, as the design's "Comparing and reporting" describes: each expected
/// write is matched to a captured change by store, table or collection, operation and key, then compared field by
/// field; a difference passes only when an unexpired approved difference covers it; a change nobody listed is extra.
/// </summary>
internal sealed class WriteComparison(ExpressionContext context, string journeyId, string stepId, string sqlStore,
    IReadOnlySet<string> hookedStores, JsonArray approved, JsonArray ignored, DateOnly today)
{
    /// <param name="expected">The step's entry in the expectations document.</param>
    /// <param name="changes">The captured changes, or <see langword="null"/> when the step has no capture (a Send without a trace).</param>
    /// <param name="effects">The captured effects.</param>
    internal List<JourneyFinding> Compare(JsonObject expected, JsonArray? changes, JsonArray? effects)
    {
        var findings = new List<JourneyFinding>();
        var used = new HashSet<int>();
        foreach (var write in (expected["writes"] as JsonArray ?? []).OfType<JsonObject>())
        {
            findings.Add(CompareWrite(write, changes, used));
        }

        if (changes is not null && expected["unlisted"]?.GetValue<string>() != "ignore")
        {
            for (var index = 0; index < changes.Count; index++)
            {
                if (!used.Contains(index) && changes[index] is JsonObject change && hookedStores.Contains(StoreOf(change)) && !IsIgnored(change))
                {
                    findings.Add(new JourneyFinding("extra", StoreOf(change), Text(change["table"]), Text(change["operation"]),
                        [.. Fields(change["after"] ?? change["before"]).Select(field => new JourneyFieldResult(field.Key, "differs", null, field.Value?.DeepClone()))], []));
                }
            }
        }

        foreach (var effect in (expected["effects"] as JsonArray ?? []).OfType<JsonObject>())
        {
            findings.Add(CompareEffect(effect, effects));
        }

        return findings;
    }

    private JourneyFinding CompareWrite(JsonObject write, JsonArray? changes, HashSet<int> used)
    {
        var store = Text(write["store"]);
        var operation = Text(write["op"]);
        if (store == "redis")
        {
            return CompareRedis(write, changes, used);
        }

        var target = Text(write["table"] ?? write["collection"]);
        if (!hookedStores.Contains(store))
        {
            return new JourneyFinding("unchecked", store, target, operation, [], [], $"Sendproof doesn't hook {store} in this host");
        }

        if (changes is null)
        {
            return new JourneyFinding("unchecked", store, target, operation, [], [], "the step has no capture of its writes");
        }

        var key = write["key"] as JsonObject ?? [];
        var values = write["values"] as JsonObject ?? [];
        var candidates = Enumerable.Range(0, changes.Count)
            .Where(index => !used.Contains(index) && changes[index] is JsonObject change && StoreOf(change) == store &&
                Text(change["table"]) == target && Text(change["operation"]) == operation &&
                key.All(part => JsonValues.Equal(Interpolation.Apply(part.Value, context), Read(change, part.Key, operation))))
            .Select(index => (Index: index, Fields: CompareFields(values, (JsonObject)changes[index]!, store, target, operation)))
            .ToList();
        if (candidates.Count == 0)
        {
            return new JourneyFinding("missing", store, target, operation,
                [.. key.Concat(values).Select(field => new JourneyFieldResult(field.Key, "differs", Interpolation.Apply(field.Value, context), null))], []);
        }

        // Several similar rows with no key are matched in order, preferring the one that agrees on most fields.
        var best = candidates.MinBy(candidate => candidate.Fields.Count(field => field.State == "differs"));
        used.Add(best.Index);
        var fields = best.Fields;
        var approvals = fields.Where(field => field.State == "approved").Select(field => field.Approved!).Distinct().ToList();
        var notes = fields.Select(field => field.Note).OfType<string>().Distinct().ToList();
        var kind = fields.Any(field => field.State == "differs") ? "differs" : approvals.Count > 0 ? "approved" : "match";
        return new JourneyFinding(kind, store, target, operation,
            [.. fields.Select(field => new JourneyFieldResult(field.Name, field.State, field.Expected, field.Actual))], approvals,
            notes.Count > 0 ? string.Join("; ", notes) : null);
    }

    private List<FieldComparison> CompareFields(JsonObject expectedValues, JsonObject change, string store, string target, string operation)
    {
        var fields = new List<FieldComparison>();
        foreach (var (name, expected) in expectedValues)
        {
            var actual = Read(change, name, operation);
            bool agrees;
            JsonNode? shown;
            switch (expected)
            {
                case JsonObject { } changed when changed.ContainsKey("from") || changed.ContainsKey("to"):
                    shown = new JsonObject { ["from"] = Interpolation.Apply(changed["from"], context), ["to"] = Interpolation.Apply(changed["to"], context) };
                    agrees = JsonValues.Equal(shown["from"], (change["before"] as JsonObject)?[name]) && JsonValues.Equal(shown["to"], (change["after"] as JsonObject)?[name]);
                    actual = new JsonObject { ["from"] = (change["before"] as JsonObject)?[name]?.DeepClone(), ["to"] = (change["after"] as JsonObject)?[name]?.DeepClone() };
                    break;
                case JsonObject { } typed when typed["type"] is { } type:
                    shown = typed.DeepClone();
                    agrees = JsonValues.HasType(Text(type), actual);
                    break;
                case JsonObject { } pattern when pattern["pattern"] is { } regex:
                    shown = pattern.DeepClone();
                    agrees = JsonValues.String(actual) is { } text && Regex.IsMatch(text, Text(regex));
                    break;
                default:
                    shown = Interpolation.Apply(expected, context);
                    agrees = JsonValues.Equal(shown, actual);
                    break;
            }

            var field = new FieldComparison(name, agrees ? "match" : "differs", shown, actual?.DeepClone());
            fields.Add(agrees ? field : Approve(field, store, target));
        }

        return fields;
    }

    /// <summary>A differing field covered by an approved difference that matches it and hasn't expired.</summary>
    private FieldComparison Approve(FieldComparison field, string store, string target)
    {
        foreach (var record in approved.OfType<JsonObject>())
        {
            var on = record["target"] as JsonObject;
            if (Text(record["journey"]) != journeyId || Text(record["step"]) != stepId || Text(record["kind"]) is not ("value" or "") ||
                Text(on?["store"]) != store || Text(on?["table"] ?? on?["collection"]) != target || Text(on?["field"]) != field.Name ||
                record.ContainsKey("expected") && !JsonValues.Equal(record["expected"], field.Expected) ||
                record.ContainsKey("actual") && !JsonValues.Equal(record["actual"], field.Actual))
            {
                continue;
            }

            var id = Text(record["id"]);
            if (record["expires"] is { } expires && DateOnly.TryParse(Text(expires), out var day) && day < today)
            {
                return field with { Note = $"{id} expired on {Text(expires)} and covers nothing" };
            }

            return field with { State = "approved", Approved = id };
        }

        return field;
    }

    private JourneyFinding CompareRedis(JsonObject write, JsonArray? changes, HashSet<int> used)
    {
        var key = Interpolation.Text(Interpolation.Apply(write["key"], context));
        var command = Text(write["op"]);
        if (!hookedStores.Contains("redis"))
        {
            return new JourneyFinding("unchecked", "redis", key, command, [], [], "Sendproof doesn't hook Redis in this host");
        }

        var index = changes is null ? -1 : Enumerable.Range(0, changes.Count).FirstOrDefault(index => !used.Contains(index) &&
            changes[index] is JsonObject change && StoreOf(change) == "redis" && Text((change["key"] as JsonObject)?["key"]) == key, -1);
        if (index < 0)
        {
            return changes is null || !changes.OfType<JsonObject>().Any(change => StoreOf(change) == "redis")
                ? new JourneyFinding("unchecked", "redis", key, command, [], [], "the step's capture has no Redis changes to compare")
                : new JourneyFinding("missing", "redis", key, command, [], []);
        }

        used.Add(index);
        return new JourneyFinding("match", "redis", key, command, [], []);
    }

    private JourneyFinding CompareEffect(JsonObject expected, JsonArray? effects)
    {
        var kind = Text(expected["kind"]);
        var wanted = expected.Where(pair => pair.Key != "kind").ToList();
        foreach (var effect in (effects ?? []).OfType<JsonObject>().Where(effect => Text(effect["kind"]) == kind))
        {
            var data = effect["data"] as JsonObject;
            var fields = wanted.Select(pair =>
            {
                var actual = data?[pair.Key];
                var value = Interpolation.Apply(pair.Value, context);
                var agrees = value is JsonObject { } pattern && pattern["pattern"] is { } regex
                    ? (actual is JsonArray list ? list : [actual?.DeepClone()]).Any(item => JsonValues.String(item) is { } text && Regex.IsMatch(text, Text(regex)))
                    : actual is JsonArray many ? many.Any(item => JsonValues.Equal(value, item)) : JsonValues.Equal(value, actual);
                return new JourneyFieldResult(pair.Key, agrees ? "match" : "differs", value, actual?.DeepClone());
            }).ToList();
            if (fields.All(field => field.State == "match"))
            {
                return new JourneyFinding("match", "effect", kind, kind, fields, []);
            }
        }

        return new JourneyFinding("missing", "effect", kind, kind,
            [.. wanted.Select(pair => new JourneyFieldResult(pair.Key, "differs", Interpolation.Apply(pair.Value, context), null))], []);
    }

    private bool IsIgnored(JsonObject change) => ignored.OfType<JsonObject>().Any(entry =>
        Text(entry["store"]) == StoreOf(change) && Text(entry["table"] ?? entry["collection"]) == Text(change["table"]));

    /// <summary>A change without <c>store</c> is the SQL database's.</summary>
    private string StoreOf(JsonObject change) => change["store"] is { } store ? Text(store) : sqlStore;

    /// <summary>A field as written: from the key, or from the row after the change (before it, for a delete).</summary>
    private static JsonNode? Read(JsonObject change, string field, string operation) =>
        (change["key"] as JsonObject)?[field] ?? (change[operation == "delete" ? "before" : "after"] as JsonObject)?[field];

    private static IEnumerable<KeyValuePair<string, JsonNode?>> Fields(JsonNode? row) => row as JsonObject ?? [];

    private static string Text(JsonNode? node) => Interpolation.Text(node);

    private sealed record FieldComparison(string Name, string State, JsonNode? Expected, JsonNode? Actual, string? Approved = null, string? Note = null);
}
