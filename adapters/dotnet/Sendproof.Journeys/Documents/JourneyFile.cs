namespace Sendproof.Journeys;

/// <summary>A hand-written or exported Arazzo file, and its expectations file if it has one, relative to the content root.</summary>
internal sealed record JourneyFile(string Path, string? ExpectationsPath);
