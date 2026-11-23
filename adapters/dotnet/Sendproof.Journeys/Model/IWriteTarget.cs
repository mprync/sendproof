namespace Sendproof.Journeys;

/// <summary>A table or collection a write goes to, named from the store's own model when the documents are built.</summary>
internal interface IWriteTarget
{
    /// <summary>The store, target and field names, or <see langword="null"/> after recording why they can't be found.</summary>
    ResolvedTarget? Resolve(JourneyGeneration generation, ICollection<string> problems);
}
