using System.Text.Json.Nodes;

namespace Sendproof.Journeys;

/// <summary>An insert, update or delete of a row or document, keyed and valued field by field.</summary>
internal sealed class FieldWrite(IWriteTarget target, string operation) : ExpectedWrite
{
    internal List<ExpectedField> Key { get; } = [];
    internal List<ExpectedField> Values { get; } = [];

    internal override bool IsGuarded => false;

    internal override JsonObject? Describe(JourneyGeneration generation, StepWrites step)
    {
        var problems = step.Journey.Problems;
        if (target.Resolve(generation, problems) is not { } resolved)
        {
            return null;
        }

        var write = new JsonObject { ["store"] = resolved.Store, [resolved.Kind] = resolved.Name, ["op"] = operation };
        if (Fields(Key, resolved, generation, step) is { Count: > 0 } key)
        {
            write["key"] = key;
        }

        if (Fields(Values, resolved, generation, step) is { Count: > 0 } values)
        {
            write["values"] = values;
        }

        return write;
    }

    private static JsonObject Fields(List<ExpectedField> fields, ResolvedTarget target, JourneyGeneration generation, StepWrites step)
    {
        var result = new JsonObject();
        foreach (var field in fields)
        {
            if (target.Field(field.Member) is not { } resolved)
            {
                step.Journey.Problems.Add($"Step {step.Step.StepId}: {target.Name} has no field for {field.Member.Text}.");
                continue;
            }

            var context = new JourneyValueContext(generation.Json, resolved.Serialize);
            var expected = field.Value.Resolve(context);
            result[resolved.Name] = expected;
            if (field.Approved is { } approved)
            {
                generation.Approve(approved, step, new JsonObject { ["store"] = target.Store, [target.Kind] = target.Name, ["field"] = resolved.Name },
                    expected?.DeepClone(), resolved.Serialize(approved.Actual, approved.ValueType));
            }
        }

        return result;
    }
}
