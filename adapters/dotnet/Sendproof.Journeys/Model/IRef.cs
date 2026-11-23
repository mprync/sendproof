namespace Sendproof.Journeys;

/// <summary>A <see cref="Ref{T}"/> without its type, for code that takes refs of any type, such as a Redis key format.</summary>
internal interface IRef
{
    JourneyRefSource Source { get; }
}
