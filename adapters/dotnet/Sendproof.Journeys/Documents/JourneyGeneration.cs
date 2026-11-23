using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata;
using Microsoft.Extensions.DependencyInjection;

namespace Sendproof.Journeys;

/// <summary>
/// What building the documents needs from the app (its JSON options, its EF Core models, the SQL store id) and what
/// it collects across journeys: the approved differences, each used by exactly one expectation.
/// </summary>
internal sealed class JourneyGeneration(IServiceProvider services, JsonSerializerOptions json, JourneyOptions options, string sqlStore)
{
    private readonly Dictionary<Type, IModel> _models = [];
    private readonly Dictionary<string, string> _approvedAt = [];

    /// <summary>Gets the app's JSON options, which name request members, inputs and outputs.</summary>
    internal JsonSerializerOptions Json { get; } = json;

    internal JourneyOptions Options { get; } = options;

    /// <summary>Gets the store id of the SQL database, as capabilities report it in <c>database.system</c>.</summary>
    internal string SqlStore { get; } = sqlStore;

    internal JsonArray ApprovedDifferences { get; } = [];

    /// <summary>The EF Core model of a context type, read from a context resolved in a scope of its own.</summary>
    internal IModel Model(Type contextType)
    {
        if (!_models.TryGetValue(contextType, out var model))
        {
            using var scope = services.CreateScope();
            var context = scope.ServiceProvider.GetService(contextType) as DbContext ??
                throw new JourneyDefinitionException($"{contextType.Name} is not registered as a DbContext.");
            _models[contextType] = model = context.Model;
        }

        return model;
    }

    /// <summary>Adds an approved difference for the expectation it relaxes, or records why it can't be added.</summary>
    internal void Approve(IApprovedDifference record, StepWrites step, JsonObject target, JsonNode? expected, JsonNode? actual)
    {
        var where = $"{step.Journey.Id}.{step.Step.StepId} {target["field"]}";
        if (string.IsNullOrWhiteSpace(record.Id) || string.IsNullOrWhiteSpace(record.Reason) || string.IsNullOrWhiteSpace(record.ApprovedBy))
        {
            step.Journey.Problems.Add($"Step {step.Step.StepId}: the approved difference for {target["field"]} needs an Id, a Reason and ApprovedBy.");
            return;
        }

        if (_approvedAt.TryGetValue(record.Id, out var used))
        {
            step.Journey.Problems.Add($"Step {step.Step.StepId}: {record.Id} already relaxes {used}; an approved difference covers one expectation.");
            return;
        }

        _approvedAt[record.Id] = where;
        var entry = new JsonObject
        {
            ["id"] = record.Id,
            ["journey"] = step.Journey.Id,
            ["step"] = step.Step.StepId,
            ["target"] = target,
            ["kind"] = "value",
            ["expected"] = expected,
            ["actual"] = actual,
            ["reason"] = record.Reason,
            ["approvedBy"] = record.ApprovedBy,
            ["approvedOn"] = Day(record.ApprovedOn)
        };
        if (record.Expires is { } expires)
        {
            entry["expires"] = Day(expires);
        }

        if (record.Link is { Length: > 0 } link)
        {
            entry["link"] = link;
        }

        ApprovedDifferences.Add(entry);
    }

    private static string Day(DateOnly day) => day.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
}
