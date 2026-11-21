using System.Text.Json.Nodes;
using MongoDB.Bson;
using MongoDB.Bson.IO;

namespace Sendproof.MongoDB;

/// <summary>Conversions between BSON and the JSON the capture carries.</summary>
internal static class BsonJson
{
    private static readonly JsonWriterSettings Relaxed = new() { OutputMode = JsonOutputMode.RelaxedExtendedJson };

    /// <summary>Most array items kept when sanitizing a command for its log entry.</summary>
    private const int SanitizedItems = 64;

    /// <summary>
    /// Converts a BSON value to JSON, using MongoDB Extended JSON v2 relaxed form for the types JSON lacks
    /// (<c>{"$oid": …}</c>, <c>{"$date": …}</c>), as the spec requires of <c>before</c> and <c>after</c>.
    /// </summary>
    internal static JsonNode? Plain(BsonValue? value)
    {
        if (value is null || value.IsBsonNull)
        {
            return null;
        }

        // A bare value has no JSON form of its own, so it travels as a field of a one-field document.
        return JsonNode.Parse(new BsonDocument("v", value).ToJson(Relaxed))!["v"]!.DeepClone();
    }

    /// <summary>
    /// Replaces every literal in a command document with <c>"?"</c>, keeping field names and operators, for the
    /// <c>statement</c> of a <c>Db</c> entry (OpenTelemetry <c>db.query.text</c>). BSON values are literals too.
    /// </summary>
    internal static BsonValue Sanitize(BsonValue value) => value switch
    {
        BsonDocument document => new BsonDocument(document.Select(element => new BsonElement(element.Name, Sanitize(element.Value)))),
        BsonArray array => new BsonArray(array.Take(SanitizedItems).Select(Sanitize)),
        _ => new BsonString("?")
    };

    /// <summary>The compact JSON text of a sanitized command.</summary>
    internal static string Text(BsonValue sanitized) => sanitized.ToJson(new JsonWriterSettings { OutputMode = JsonOutputMode.CanonicalExtendedJson, Indent = false });
}
