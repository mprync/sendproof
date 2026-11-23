namespace Sendproof.Journeys;

/// <summary>A field's name in its store and the serializer that writes its values as the store's changes report them.</summary>
internal sealed record ResolvedField(string Name, ValueSerializer Serialize);
