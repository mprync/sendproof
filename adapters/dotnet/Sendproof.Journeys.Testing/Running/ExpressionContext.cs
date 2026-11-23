using System.Text.Json.Nodes;
using Bielu.Arazzo.Expressions;
using Json.Pointer;

namespace Sendproof.Journeys.Testing;

/// <summary>
/// The values Arazzo runtime expressions read during a run (inputs, step outputs, the current response), evaluated
/// with Bielu.Arazzo's parser and evaluator.
/// </summary>
internal sealed class ExpressionContext(JsonObject inputs) : IRuntimeExpressionContext
{
    internal Dictionary<string, JsonObject> Outputs { get; } = [];
    internal JsonNode? ResponseBody { get; set; }
    internal Dictionary<string, string> ResponseHeaders { get; set; } = new(StringComparer.OrdinalIgnoreCase);
    internal int? Status { get; set; }

    public string? Self => null;
    public string? Url => null;
    public string? Method => null;
    public int? StatusCode => Status;

    /// <summary>Evaluates one runtime expression, such as <c>$steps.placeOrder.outputs.orderId</c>.</summary>
    internal JsonNode? Evaluate(string expression) => RuntimeExpressionParser.TryParse(expression, out var parsed, out var error)
        ? RuntimeExpressionEvaluator.Evaluate(parsed!, this)?.DeepClone()
        : throw new InvalidOperationException($"{expression} is not an Arazzo runtime expression: {error}");

    internal static bool IsExpression(string text) => text.StartsWith('$') && RuntimeExpressionParser.TryParse(text, out _, out _);

    public JsonNode? GetResponseValue(RuntimeExpressionSource source) => source.Kind switch
    {
        // The evaluator applies pointers to inputs and outputs; a response source carries its pointer for the context.
        RuntimeExpressionSourceKind.Body => string.IsNullOrEmpty(source.JsonPointer) ? ResponseBody
            : JsonPointer.Parse(source.JsonPointer).TryEvaluate(ResponseBody, out var value) ? value : null,
        RuntimeExpressionSourceKind.Header when source.Name is { } name => ResponseHeaders.TryGetValue(name, out var header) ? JsonValue.Create(header) : null,
        _ => null
    };

    public JsonNode? GetInput(string name) => inputs[name];
    public JsonNode? GetStepOutput(string stepId, string outputName) => Outputs.TryGetValue(stepId, out var outputs) ? outputs[outputName] : null;
    public JsonNode? GetRequestValue(RuntimeExpressionSource source) => null;
    public JsonNode? GetMessageValue(RuntimeExpressionSource source) => null;
    public JsonNode? GetOutput(string name) => null;
    public JsonNode? GetWorkflowField(string workflowName, string field, string? fieldName) => null;
    public JsonNode? GetSourceDescriptionReference(string sourceName, string referenceId) => null;
    public JsonNode? GetComponent(string field, string name) => null;
}
