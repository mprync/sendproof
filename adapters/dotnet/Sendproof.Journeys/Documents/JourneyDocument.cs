using System.Text.Json.Nodes;

namespace Sendproof.Journeys;

/// <summary>One served pair: an Arazzo document and its expectations document.</summary>
/// <param name="Name">The name the workbench shows.</param>
/// <param name="FileName">The file name both are served under, without extension.</param>
/// <param name="Source"><c>code</c> for journeys defined in C#, <c>file</c> for a registered Arazzo file.</param>
/// <param name="Arazzo">The Arazzo document, with the OpenAPI document's URL before any path base.</param>
/// <param name="Expectations">The expectations document.</param>
internal sealed record JourneyDocument(string Name, string FileName, string Source, JsonNode Arazzo, JsonNode Expectations)
{
    internal string ArazzoFile => FileName + ".arazzo.json";
    internal string ExpectationsFile => FileName + ".expect.json";
}
