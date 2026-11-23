using System.ComponentModel;

namespace Sendproof.Journeys;

/// <summary>
/// Records the file a journey class is declared in, relative to its project, so the expectations document can say
/// where a journey is defined. The operations generator writes one per journey class; you never write it yourself.
/// </summary>
[AttributeUsage(AttributeTargets.Assembly, AllowMultiple = true)]
[EditorBrowsable(EditorBrowsableState.Never)]
public sealed class JourneySourceAttribute(Type journey, string file) : Attribute
{
    /// <summary>Gets the journey class.</summary>
    public Type Journey { get; } = journey;

    /// <summary>Gets the file, relative to the project, with forward slashes.</summary>
    public string File { get; } = file;
}
