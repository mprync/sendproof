namespace Sendproof.Journeys;

/// <summary>A write target with its names: the store id, <c>table</c> or <c>collection</c>, its name, and each field's name and serializer.</summary>
/// <param name="Store">The store id: the SQL <c>database.system</c>, or a data store's <c>system</c>.</param>
/// <param name="Kind">The expectations key for the target: <c>table</c> or <c>collection</c>.</param>
/// <param name="Name">The table or collection name.</param>
/// <param name="Field">The name and serializer of a member, or <see langword="null"/> when the model has no such field.</param>
internal sealed record ResolvedTarget(string Store, string Kind, string Name, Func<MemberPath, ResolvedField?> Field);
