using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using Bielu.Arazzo.Models;
using Microsoft.AspNetCore.Http.Metadata;

namespace Sendproof.Journeys;

/// <summary>Turns a described journey into an Arazzo 1.1 workflow, with the Bielu.Arazzo object model.</summary>
internal static class ArazzoWorkflowWriter
{
    internal static ArazzoWorkflow Write(JourneyModel journey, JourneyGeneration generation)
    {
        var json = generation.Json;
        var workflow = new ArazzoWorkflow
        {
            WorkflowId = journey.Id,
            Summary = journey.Name ?? journey.Id,
            Description = journey.Description,
            Inputs = InputSchema.For(journey.InputsType, json),
            Steps = []
        };

        foreach (var step in journey.Steps)
        {
            var arazzo = new ArazzoStep
            {
                StepId = step.StepId,
                OperationId = step.OperationId,
                Parameters = [.. step.Parameters.Select(parameter => ArazzoReferenceable<ArazzoParameter>.Of(Parameter(parameter, json)))],
                SuccessCriteria = [.. step.Criteria.Select(criterion => new ArazzoCriterion { Condition = criterion(json) })],
                Outputs = new Dictionary<string, ArazzoValue>()
            };
            if (step.Body.Count > 0)
            {
                arazzo.RequestBody = new ArazzoRequestBody
                {
                    ContentType = "application/json",
                    Payload = ArazzoValue.FromLiteral(Payload(journey, step, json))
                };
            }

            foreach (var output in step.Outputs)
            {
                var name = output.ValueName(json);
                if (!arazzo.Outputs.TryAdd(name, ArazzoValue.FromExpression("$response.body#" + output.Path.Pointer(json))))
                {
                    journey.Problems.Add($"Step {step.StepId}: two outputs are named {name}; name one with Output(…, \"name\").");
                }
            }

            workflow.Steps.Add(arazzo);
        }

        return workflow;
    }

    private static ArazzoParameter Parameter(RequestValue parameter, JsonSerializerOptions json)
    {
        var member = parameter.Target.Root;
        var attributes = member.GetCustomAttributes().ToList();
        var (name, location) = attributes switch
        {
            _ when attributes.OfType<IFromRouteMetadata>().FirstOrDefault() is { } route => (route.Name, ArazzoParameterLocation.Path),
            _ when attributes.OfType<IFromHeaderMetadata>().FirstOrDefault() is { } header => (header.Name, ArazzoParameterLocation.Header),
            _ => (attributes.OfType<IFromQueryMetadata>().First().Name, ArazzoParameterLocation.Query)
        };

        return new ArazzoParameter
        {
            Name = name ?? member.Name,
            In = location,
            Value = Value(parameter.Value, json)
        };
    }

    /// <summary>
    /// The request body as one JSON value. Refs stay runtime expressions inside it (<c>"$inputs.quantity"</c>), which
    /// Arazzo evaluates before the call; members set one by one are placed at their JSON pointers.
    /// </summary>
    private static JsonNode? Payload(JourneyModel journey, StepModel step, JsonSerializerOptions json)
    {
        JsonNode? payload = null;
        foreach (var body in step.Body)
        {
            var value = body.Value.Resolve(Context(json));
            var segments = body.Target.Segments.Skip(1).ToList();
            var names = body.Target.Names(json).Skip(1).ToList();
            if (segments.Count == 0)
            {
                payload = value;
                continue;
            }

            payload ??= segments[0].Index is null ? new JsonObject() : new JsonArray();
            var parent = payload;
            for (var i = 0; i < segments.Count && parent is not null; i++)
            {
                var last = i == segments.Count - 1;
                JsonNode? Child() => last ? value : segments[i + 1].Index is null ? new JsonObject() : new JsonArray();
                switch (parent, segments[i].Index)
                {
                    case (JsonObject container, null):
                        if (last || container[names[i]] is null)
                        {
                            container[names[i]] = Child();
                        }

                        parent = container[names[i]];
                        break;
                    case (JsonArray list, { } index):
                        while (list.Count <= index)
                        {
                            list.Add(null);
                        }

                        if (last || list[index] is null)
                        {
                            list[index] = Child();
                        }

                        parent = list[index];
                        break;
                    default:
                        journey.Problems.Add($"Step {step.StepId}: {body.Target.Text} doesn't fit the body set before it.");
                        parent = null;
                        break;
                }
            }
        }

        return payload;
    }

    private static ArazzoValue Value(JourneyValue value, JsonSerializerOptions json) => value.References.Count > 0
        ? ArazzoValue.FromExpression(value.Resolve(Context(json))!.GetValue<string>())
        : ArazzoValue.FromLiteral(value.Resolve(Context(json)));

    private static JourneyValueContext Context(JsonSerializerOptions json) =>
        new(json, (literal, type) => JsonSerializer.SerializeToNode(literal, type, json));
}
