using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Schema;
using Namotion.Reflection;

namespace Sendproof.Journeys;

/// <summary>
/// The Arazzo <c>inputs</c> schema of an inputs class: the JSON Schema System.Text.Json exports for it with the app's
/// options, each property's XML summary as its description, and the values a new instance holds as defaults.
/// </summary>
internal static class InputSchema
{
    internal static JsonNode For(Type inputsType, JsonSerializerOptions json)
    {
        var schema = json.GetJsonSchemaAsNode(inputsType, new JsonSchemaExporterOptions
        {
            TransformSchemaNode = (context, node) =>
            {
                if (node is JsonObject property && context.PropertyInfo?.AttributeProvider is PropertyInfo member &&
                    member.GetXmlDocsSummary() is { Length: > 0 } summary)
                {
                    property["description"] = summary;
                }

                return node;
            }
        });

        // The inputs are always an object; the exporter allows null for a class that nullable analysis can't vouch for.
        if (schema is JsonObject root && root["type"] is JsonArray)
        {
            root["type"] = "object";
        }

        if (schema["properties"] is JsonObject properties &&
            JsonSerializer.SerializeToNode(Activator.CreateInstance(inputsType), inputsType, json) is JsonObject defaults)
        {
            foreach (var (name, property) in properties)
            {
                // A Guid left empty has no meaningful default; the person running the journey picks one.
                if (property is JsonObject described && defaults[name] is { } value &&
                    value.ToJsonString() != JsonSerializer.Serialize(Guid.Empty))
                {
                    described["default"] = value.DeepClone();
                }
            }
        }

        return schema;
    }
}
