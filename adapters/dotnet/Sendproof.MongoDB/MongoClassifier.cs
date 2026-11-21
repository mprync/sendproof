using MongoDB.Bson;
using Sendproof.AspNetCore;

namespace Sendproof.MongoDB;

/// <summary>The result of classifying a MongoDB command document.</summary>
/// <param name="Kind">Read, write or session. Only a write can block a Preview in guard mode.</param>
/// <param name="RefusedInTransaction">The command or aggregation stage MongoDB refuses inside a transaction, such as <c>$out</c>.</param>
internal readonly record struct MongoClassification(CommandKind Kind, string? RefusedInTransaction = null);

/// <summary>
/// Write classification for MongoDB command documents, driven by the shared table in spec/data-stores/mongodb.json
/// (embedded in <c>Sendproof.AspNetCore</c>). The command name is the document's first key, compared
/// case-insensitively. Everything the table doesn't list, including a command it has never heard of, is a write.
/// </summary>
internal static class MongoClassifier
{
    private static readonly HashSet<string> WritingStages = new(["$out", "$merge"], StringComparer.Ordinal);

    /// <summary>
    /// Classifies a command document by its first key. <c>aggregate</c> is a write when any stage at any depth is
    /// <c>$out</c> or <c>$merge</c>; <c>explain</c> takes the classification of the command inside it.
    /// <see cref="MongoClassification.RefusedInTransaction"/> names what a <c>preview</c>-mode Preview must block before
    /// sending. <paramref name="treatAsRead"/> holds host-declared reads in lower case.
    /// </summary>
    internal static MongoClassification Classify(BsonDocument command, IReadOnlySet<string>? treatAsRead = null)
    {
        var table = StoreTables.Mongo;
        var name = command.ElementCount > 0 ? command.GetElement(0).Name : "";
        var lower = name.ToLowerInvariant();
        if (lower == "explain" && command[0] is BsonDocument inner)
        {
            return Classify(inner, treatAsRead);
        }

        string? refused = null;
        if (table.NotInTransaction.Contains(lower))
        {
            refused = name;
        }

        BsonValue? pipeline = null;
        if (lower == "aggregate")
        {
            pipeline = command.TryGetValue("pipeline", out var stages) ? stages : null;
            refused = table.Stages.FirstOrDefault(stage => Uses(pipeline, new HashSet<string>([stage], StringComparer.Ordinal))) ?? refused;
        }

        if (table.Session.Contains(lower))
        {
            return new MongoClassification(CommandKind.Session);
        }

        if (lower == "aggregate" && Uses(pipeline, WritingStages))
        {
            return new MongoClassification(CommandKind.Write, refused);
        }

        return new MongoClassification(table.Read.Contains(lower) || treatAsRead?.Contains(lower) == true ? CommandKind.Read : CommandKind.Write, refused);
    }

    /// <summary>Whether any key of an aggregation pipeline, at any depth (sub-pipelines included), is in <paramref name="stages"/>.</summary>
    internal static bool Uses(BsonValue? value, IReadOnlySet<string> stages) => value switch
    {
        BsonArray array => array.Any(item => Uses(item, stages)),
        BsonDocument document => document.Any(element => stages.Contains(element.Name) || Uses(element.Value, stages)),
        _ => false
    };
}
