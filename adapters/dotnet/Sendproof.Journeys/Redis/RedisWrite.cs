using System.Text.Json;
using System.Text.Json.Nodes;

namespace Sendproof.Journeys;

/// <summary>One Redis command a step should send: <c>{ "store": "redis", "key": …, "op": "INCRBY" }</c>.</summary>
internal sealed class RedisWrite(RedisCommand command, JourneyValue key, JourneyValue? expiry) : ExpectedWrite
{
    internal override bool IsGuarded => true;

    internal override JsonObject Describe(JourneyGeneration generation, StepWrites step)
    {
        var context = new JourneyValueContext(generation.Json, (value, type) => JsonSerializer.SerializeToNode(value, type, generation.Json));
        var write = new JsonObject { ["store"] = "redis", ["key"] = key.Resolve(context), ["op"] = command.ToString().ToUpperInvariant() };
        if (expiry is not null)
        {
            write["values"] = new JsonObject { ["expiry"] = expiry.Resolve(context) };
        }

        return write;
    }
}
