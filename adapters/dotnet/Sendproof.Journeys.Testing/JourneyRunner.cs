using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json.Nodes;
using Bielu.Arazzo.Models;
using Bielu.Arazzo.Readers;

namespace Sendproof.Journeys.Testing;

/// <summary>
/// Runs a journey against a Sendproof host over HTTP, reading the same Arazzo and expectations documents the workbench
/// and the CLI read: binds each step from inputs and earlier outputs, runs it (inside one Preview session, or sent with
/// Observed Send), checks its success criteria and compares what it wrote with its expectations.
/// </summary>
/// <param name="client">A client for the host, which keeps the persona's sign-in cookie between requests.</param>
public sealed class JourneyRunner(HttpClient client)
{
    private const string Mount = "/sendproof";

    /// <summary>
    /// Gets whether the runner may send steps for real: for a Send-only journey, a <see cref="JourneyRunMode.Send"/>
    /// run, or a host without Preview sessions. Allow it only against a throwaway database.
    /// </summary>
    public bool AllowSend { get; init; }

    /// <summary>The IDs of every journey the host publishes.</summary>
    public async Task<IReadOnlyList<string>> ListAsync(CancellationToken cancellationToken = default)
    {
        var capabilities = await JsonAsync($"{Mount}/_api/capabilities", cancellationToken);
        var ids = new List<string>();
        foreach (var entry in (capabilities["journeys"] as JsonArray ?? []).OfType<JsonObject>())
        {
            var document = await ArazzoAsync(Text(entry["arazzoUrl"]), cancellationToken);
            ids.AddRange(document.Workflows.Select(workflow => workflow.WorkflowId));
        }

        return ids;
    }

    /// <summary>Runs one journey to its end or its first stop.</summary>
    /// <param name="journeyId">The Arazzo workflowId.</param>
    /// <param name="mode">Preview (the default) or Send. A Send-only journey is always sent.</param>
    /// <param name="inputs">Values for the journey's inputs; the rest come from the inputs schema's defaults.</param>
    /// <param name="cancellationToken">Stops the run.</param>
    public async Task<JourneyRunResult> RunAsync(string journeyId, JourneyRunMode mode = JourneyRunMode.Preview, JsonObject? inputs = null,
        CancellationToken cancellationToken = default)
    {
        var capabilities = await JsonAsync($"{Mount}/_api/capabilities", cancellationToken);
        var (workflow, expectations) = await FindAsync(capabilities, journeyId, cancellationToken);
        var operations = await OpenApiOperations.LoadAsync(client, Text(capabilities["openApiUrl"]), cancellationToken);
        var journey = expectations["journeys"]?[journeyId] as JsonObject ?? [];
        var notes = new List<string>();
        if (mode == JourneyRunMode.Preview && journey["sendOnly"]?.GetValue<bool>() == true)
        {
            mode = JourneyRunMode.Send;
            notes.Add($"Send only: {Text(journey["sendOnlyReason"])}");
        }
        else if (mode == JourneyRunMode.Preview && capabilities["previewSessions"]?.GetValue<bool>() != true)
        {
            mode = JourneyRunMode.Send;
            notes.Add("The host can't hold a Preview session, so the steps were sent.");
        }

        var name = workflow.Summary ?? journeyId;
        if (mode == JourneyRunMode.Send && !AllowSend)
        {
            notes.Add("This run needs to send for real. Set AllowSend once the host uses a throwaway database.");
            return new JourneyRunResult(journeyId, name, mode, [.. workflow.Steps.Select(step => Skipped(step, "Not sent: AllowSend is off."))], notes);
        }

        var context = new ExpressionContext(Inputs(workflow, inputs));
        var sqlStore = capabilities["database"] is JsonObject database ? Text(database["system"]) : "sql";
        var hooked = new HashSet<string>((capabilities["dataStores"] as JsonArray ?? []).OfType<JsonObject>().Select(store => Text(store["system"])));
        if (capabilities["database"] is not null)
        {
            hooked.Add(sqlStore);
        }

        var personas = (capabilities["authProviders"] as JsonArray ?? []).OfType<JsonObject>().FirstOrDefault(provider => Text(provider["kind"]) == "personas");
        string? persona = null;
        if (Text(journey["runAs"]) is { Length: > 0 } runAs && personas is not null)
        {
            // A session belongs to the signed-in caller, so sign in before opening it.
            await SignInAsync(Text(personas["url"]), runAs, cancellationToken);
            persona = runAs;
        }

        var session = mode == JourneyRunMode.Preview ? await OpenSessionAsync(cancellationToken) : null;
        var steps = new List<JourneyStepResult>();
        try
        {
            foreach (var step in workflow.Steps)
            {
                if (steps.Count > 0 && steps[^1].Status != "passed")
                {
                    steps.Add(Skipped(step, "Not run: the run stopped."));
                    continue;
                }

                var expected = journey["steps"]?[step.StepId] as JsonObject;
                var wanted = Text(expected?["persona"] ?? journey["runAs"]);
                if (wanted.Length > 0 && wanted != persona && personas is not null)
                {
                    await SignInAsync(Text(personas["url"]), wanted, cancellationToken);
                    persona = wanted;
                }

                var comparison = new WriteComparison(context, journeyId, step.StepId, sqlStore, hooked,
                    expectations["approvedDifferences"] as JsonArray ?? [], expectations["ignore"] as JsonArray ?? [], DateOnly.FromDateTime(DateTime.UtcNow));
                steps.Add(await RunStepAsync(step, expected, operations, context, comparison, session, cancellationToken));
            }
        }
        finally
        {
            if (session is not null)
            {
                await client.DeleteAsync($"{Mount}/_api/sessions/{session}", CancellationToken.None);
            }
        }

        return new JourneyRunResult(journeyId, name, mode, steps, notes);
    }

    private async Task<JourneyStepResult> RunStepAsync(ArazzoStep step, JsonObject? expected, Dictionary<string, (HttpMethod Method, string Path)> operations,
        ExpressionContext context, WriteComparison comparison, string? session, CancellationToken cancellationToken)
    {
        if (step.OperationId is not { } operationId || !operations.TryGetValue(operationId, out var operation))
        {
            return new JourneyStepResult(step.StepId, step.OperationId ?? step.OperationPath ?? step.WorkflowId ?? "", "failed", null, [], [], [],
                "Not run by Sendproof: the step doesn't call an operation of the OpenAPI document by its operationId.");
        }

        var request = Request(step, operation, context, session);
        using var response = await client.SendAsync(request, cancellationToken);
        var outcome = await OutcomeAsync(response, session is not null, cancellationToken);
        if (outcome.Blocked is { } blocked)
        {
            return new JourneyStepResult(step.StepId, operationId, "blocked", null, [], [], [], blocked);
        }

        context.Status = outcome.Status;
        context.ResponseBody = outcome.Body;
        context.ResponseHeaders = outcome.Headers;
        var criteria = (step.SuccessCriteria ?? []).Select(criterion => Criteria.Check(criterion, context)).ToList();
        var outputs = new JsonObject();
        foreach (var (name, value) in step.Outputs ?? new Dictionary<string, ArazzoValue>())
        {
            outputs[name] = Value(value, context);
        }

        context.Outputs[step.StepId] = outputs;
        var findings = expected is null ? [] : comparison.Compare(expected, outcome.Changes, outcome.Effects);
        var status = criteria.All(criterion => criterion.Passed) ? "passed" : outcome.Status >= 400 ? "refused" : "failed";
        return new JourneyStepResult(step.StepId, operationId, status, outcome.Status, criteria, findings, outputs,
            status == "passed" ? null : outcome.Body?.ToJsonString());
    }

    private static HttpRequestMessage Request(ArazzoStep step, (HttpMethod Method, string Path) operation, ExpressionContext context, string? session)
    {
        var path = operation.Path;
        var query = new List<string>();
        var headers = new List<(string, string)>();
        foreach (var parameter in (step.Parameters ?? []).Where(parameter => !parameter.IsReference).Select(parameter => parameter.Value!))
        {
            var value = Interpolation.Text(Value(parameter.Value, context));
            switch (parameter.In?.Value)
            {
                case "path":
                    path = path.Replace("{" + parameter.Name + "}", Uri.EscapeDataString(value), StringComparison.Ordinal);
                    break;
                case "header":
                    headers.Add((parameter.Name, value));
                    break;
                default:
                    query.Add($"{Uri.EscapeDataString(parameter.Name)}={Uri.EscapeDataString(value)}");
                    break;
            }
        }

        var target = path + (query.Count > 0 ? "?" + string.Join('&', query) : "");
        var request = new HttpRequestMessage(operation.Method, session is null ? target : $"{Mount}/_preview{target}");
        if (session is null)
        {
            request.Headers.Add("Prefer", "trace");
        }
        else
        {
            request.Headers.Add("Prefer", "tx=rollback");
            request.Headers.Add("Sendproof-Session", session);
        }

        foreach (var (name, value) in headers)
        {
            request.Headers.TryAddWithoutValidation(name, value);
        }

        if (step.RequestBody?.Payload is { } payload)
        {
            request.Content = new StringContent(Value(payload, context)?.ToJsonString() ?? "null", Encoding.UTF8, step.RequestBody.ContentType ?? "application/json");
        }

        return request;
    }

    /// <summary>What a step's response says: a Preview envelope, or a sent response with its Observed Send trace.</summary>
    private async Task<StepOutcome> OutcomeAsync(HttpResponseMessage response, bool preview, CancellationToken cancellationToken)
    {
        var text = await response.Content.ReadAsStringAsync(cancellationToken);
        var body = Parse(text);
        if (preview)
        {
            if (response.StatusCode == HttpStatusCode.Conflict && Text(body?["code"]) is "preview_unavailable" or "session_failed")
            {
                return new StepOutcome(0, null, [], null, null, Text(body?["detail"]));
            }

            if (response.StatusCode != HttpStatusCode.OK || body is not JsonObject envelope || envelope["rolledBack"]?.GetValue<bool>() != true)
            {
                return new StepOutcome(0, null, [], null, null, $"The Preview wasn't confirmed: {(int)response.StatusCode} {text}");
            }

            var headers = (envelope["headers"] as JsonObject ?? []).ToDictionary(pair => pair.Key, pair => Text(pair.Value), StringComparer.OrdinalIgnoreCase);
            return new StepOutcome(envelope["status"]!.GetValue<int>(), envelope["body"]?.DeepClone(), headers,
                envelope["changes"] as JsonArray ?? [], envelope["effects"] as JsonArray ?? [], null);
        }

        var sent = response.Headers.Concat(response.Content.Headers).ToDictionary(pair => pair.Key, pair => string.Join(", ", pair.Value), StringComparer.OrdinalIgnoreCase);
        JsonArray? changes = null;
        JsonArray? effects = null;
        if (response.Headers.TryGetValues("X-Sendproof-Trace", out var ids))
        {
            var trace = await JsonAsync($"{Mount}/_api/traces/{ids.First()}", cancellationToken);
            changes = trace["changes"] as JsonArray ?? [];
            effects = trace["effects"] as JsonArray ?? [];
        }

        return new StepOutcome((int)response.StatusCode, body, sent, changes, effects, null);
    }

    private async Task<string> OpenSessionAsync(CancellationToken cancellationToken)
    {
        using var response = await client.PostAsync($"{Mount}/_api/sessions", null, cancellationToken);
        var body = Parse(await response.Content.ReadAsStringAsync(cancellationToken));
        return response.StatusCode == HttpStatusCode.Created && Text(body?["id"]) is { Length: > 0 } id ? id
            : throw new InvalidOperationException($"The host didn't open a Preview session: {(int)response.StatusCode} {body?.ToJsonString()}");
    }

    private async Task SignInAsync(string personasUrl, string email, CancellationToken cancellationToken)
    {
        using var response = await client.PostAsync($"{personasUrl.TrimEnd('/')}/{Uri.EscapeDataString(email)}", null, cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            throw new InvalidOperationException($"Couldn't switch to the persona {email}: {(int)response.StatusCode}.");
        }
    }

    private async Task<(ArazzoWorkflow Workflow, JsonObject Expectations)> FindAsync(JsonObject capabilities, string journeyId, CancellationToken cancellationToken)
    {
        foreach (var entry in (capabilities["journeys"] as JsonArray ?? []).OfType<JsonObject>())
        {
            var document = await ArazzoAsync(Text(entry["arazzoUrl"]), cancellationToken);
            if (document.Workflows.FirstOrDefault(workflow => workflow.WorkflowId == journeyId) is { } workflow)
            {
                return (workflow, await JsonAsync(Text(entry["expectationsUrl"]), cancellationToken));
            }
        }

        throw new InvalidOperationException($"The host publishes no journey {journeyId}.");
    }

    private async Task<ArazzoDocument> ArazzoAsync(string url, CancellationToken cancellationToken)
    {
        var read = ArazzoStringReader.Read(await client.GetStringAsync(url, cancellationToken), new ArazzoReaderSettings());
        return read.Document ?? throw new InvalidOperationException($"{url} isn't an Arazzo document: {string.Join("; ", read.Diagnostics.Errors)}");
    }

    private async Task<JsonObject> JsonAsync(string url, CancellationToken cancellationToken) =>
        await client.GetFromJsonAsync<JsonObject>(url, cancellationToken) ?? throw new InvalidOperationException($"{url} returned no JSON.");

    /// <summary>The inputs: each schema default, then the values given.</summary>
    private static JsonObject Inputs(ArazzoWorkflow workflow, JsonObject? given)
    {
        var inputs = new JsonObject();
        foreach (var (name, property) in workflow.Inputs?["properties"] as JsonObject ?? [])
        {
            if (property?["default"] is { } value)
            {
                inputs[name] = value.DeepClone();
            }
        }

        foreach (var (name, value) in given ?? [])
        {
            inputs[name] = value?.DeepClone();
        }

        return inputs;
    }

    private static JsonNode? Value(ArazzoValue value, ExpressionContext context) =>
        value.IsExpression ? context.Evaluate(value.Expression!) : Interpolation.Apply(value.Literal, context);

    private static JourneyStepResult Skipped(ArazzoStep step, string detail) =>
        new(step.StepId, step.OperationId ?? "", "skipped", null, [], [], [], detail);

    private static JsonNode? Parse(string text)
    {
        try
        {
            return text.Length == 0 ? null : JsonNode.Parse(text);
        }
        catch (System.Text.Json.JsonException)
        {
            return JsonValue.Create(text);
        }
    }

    private static string Text(JsonNode? node) => Interpolation.Text(node);

    private sealed record StepOutcome(int Status, JsonNode? Body, Dictionary<string, string> Headers, JsonArray? Changes, JsonArray? Effects, string? Blocked);
}
