using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Sendproof.Journeys;

/// <summary>
/// Writes a journey's entry in the expectations document: its group, persona and Send-only reason, where it is defined,
/// and per step the persona, the writes, the effects and what to do with writes nobody listed.
/// </summary>
internal static class ExpectationsWriter
{
    /// <param name="journey">The journey.</param>
    /// <param name="generation">The generation context.</param>
    /// <param name="sendOnlyReason">Why the journey can't run as a Preview, or <see langword="null"/> when it can.</param>
    internal static JsonObject Write(JourneyModel journey, JourneyGeneration generation, string? sendOnlyReason)
    {
        var entry = new JsonObject();
        if (journey.Group is { } group)
        {
            entry["group"] = group;
        }

        if (journey.RunAs is { } runAs)
        {
            entry["runAs"] = runAs;
        }

        if (sendOnlyReason is not null)
        {
            entry["sendOnly"] = true;
            entry["sendOnlyReason"] = sendOnlyReason;
        }

        var definedIn = new JsonObject { ["type"] = journey.Type.Name };
        if (journey.Type.Assembly.GetCustomAttributes<JourneySourceAttribute>().FirstOrDefault(source => source.Journey == journey.Type) is { } file)
        {
            definedIn["file"] = file.File;
        }

        entry["definedIn"] = definedIn;
        var steps = new JsonObject();
        foreach (var step in journey.Steps)
        {
            var expected = new JsonObject();
            if (step.RunAs is { } persona)
            {
                expected["persona"] = persona;
            }

            if (step.Writes is { } writes)
            {
                expected["writes"] = new JsonArray([.. writes.Writes.Select(write => write.Describe(generation, writes)).OfType<JsonNode>()]);
                if (writes.Effects.Count > 0 || writes.ExpectsNothing)
                {
                    expected["effects"] = new JsonArray([.. writes.Effects.Select(effect => Effect(effect, generation.Json))]);
                }

                expected["unlisted"] = "fail";
            }

            if (expected.Count > 0)
            {
                steps[step.StepId] = expected;
            }
        }

        entry["steps"] = steps;
        return entry;
    }

    private static JsonObject Effect(ExpectedEffect effect, JsonSerializerOptions json)
    {
        var context = new JourneyValueContext(json, (value, type) => JsonSerializer.SerializeToNode(value, type, json));
        var described = new JsonObject { ["kind"] = effect.Kind };
        foreach (var (key, value) in effect.Data)
        {
            described[key] = value.Resolve(context);
        }

        return described;
    }
}
