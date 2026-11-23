using System.Text.Json.Nodes;

namespace Sendproof.Journeys;

/// <summary>
/// A value that can't be known in advance, such as a generated date or a tracking number. It is typed, so a matcher
/// can only be set where a value of <typeparamref name="T"/> goes. Get one from <see cref="Match"/>.
/// </summary>
/// <typeparam name="T">The type of the value it matches.</typeparam>
public sealed class Matcher<T>
{
    private readonly Func<JourneyValueContext, JsonNode?> _build;

    internal Matcher(Func<JourneyValueContext, JsonNode?> build) => _build = build;

    internal JourneyValue Value => JourneyValue.Of(_build, []);
}
