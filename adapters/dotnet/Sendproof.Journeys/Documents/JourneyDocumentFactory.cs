using System.Text.Json;
using System.Text.Json.Nodes;
using Bielu.Arazzo;
using Bielu.Arazzo.Models;
using Bielu.Arazzo.Readers;
using Bielu.Arazzo.Validation;
using Bielu.Arazzo.Writers;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;
using Sendproof.AspNetCore;
using HttpJsonOptions = Microsoft.AspNetCore.Http.Json.JsonOptions;

namespace Sendproof.Journeys;

/// <summary>
/// Builds the served documents from what was registered: one Arazzo 1.1 document and expectations document for the
/// journeys defined in code, and one pair per registered file. Collects every problem; a journey or file with problems
/// is left out.
/// </summary>
internal sealed class JourneyDocumentFactory(IServiceProvider services, JourneyRegistry registry, SendproofOptions sendproof,
    IHostEnvironment environment, JourneyDocuments documents, IOptions<HttpJsonOptions> json)
{
    internal const string ArazzoVersion = "1.1.0";

    internal (IReadOnlyList<JourneyDocument> Documents, IReadOnlyList<string> Problems) Build()
    {
        var problems = new List<string>();
        var documents = new List<JourneyDocument>();
        var workflowIds = new Dictionary<string, string>();
        if (registry.Journeys.Count > 0 && BuildCode(problems, workflowIds) is { } code)
        {
            documents.Add(code);
        }

        foreach (var file in registry.Files)
        {
            if (BuildFile(file, problems, workflowIds) is { } document)
            {
                documents.Add(document);
            }
        }

        return (documents, problems);
    }

    private JourneyDocument? BuildCode(List<string> problems, Dictionary<string, string> workflowIds)
    {
        var options = registry.Options;
        var generation = new JourneyGeneration(services, json.Value.SerializerOptions, options, SqlStore());
        var operations = Operations();
        var workflows = new List<ArazzoWorkflow>();
        var expectations = new JsonObject();
        foreach (var type in registry.Journeys.Distinct())
        {
            var journey = ((Journey)Activator.CreateInstance(type)!).Describe();
            if (workflowIds.TryGetValue(journey.Id, out var other))
            {
                journey.Problems.Add($"Its ID {journey.Id} is also the ID of {other}.");
            }

            workflowIds.TryAdd(journey.Id, type.Name);
            string? sendOnly = null;
            foreach (var step in journey.Steps)
            {
                if (!operations.TryGetValue(step.OperationId, out var mark))
                {
                    journey.Problems.Add($"Step {step.StepId}: no mapped endpoint is named {step.OperationId}.");
                }
                else if (mark is { Enabled: false })
                {
                    sendOnly ??= $"Step {step.StepId} is Send only: {mark.Reason?.TrimEnd('.', ' ') ?? "its operation is marked preview: false"}.";
                }

                if (step.Writes?.Writes.FirstOrDefault(write => write.IsGuarded) is not null)
                {
                    sendOnly ??= $"Step {step.StepId} writes to Redis, which can't roll back.";
                }
            }

            ArazzoWorkflow? workflow = null;
            JsonObject? entry = null;
            try
            {
                workflow = ArazzoWorkflowWriter.Write(journey, generation);
                entry = ExpectationsWriter.Write(journey, generation, sendOnly);
                journey.Problems.AddRange(Validate(Document(options.Name, [workflow])));
            }
            catch (JourneyDefinitionException exception)
            {
                journey.Problems.Add(exception.Message);
            }

            if (journey.Problems.Count > 0)
            {
                problems.AddRange(journey.Problems.Distinct().Select(problem => $"{type.Name}: {problem}"));
                continue;
            }

            workflows.Add(workflow!);
            expectations[journey.Id] = entry;
        }

        var document = new JsonObject
        {
            ["sendproofExpectations"] = "1.0",
            ["arazzo"] = options.FileName + ".arazzo.json"
        };
        if (options.Ignored.Count > 0)
        {
            document["ignore"] = new JsonArray([.. options.Ignored.Select(ignored => new JsonObject { ["store"] = ignored.Store, ["table"] = ignored.Table })]);
        }

        document["journeys"] = expectations;
        // A skipped journey's approved differences go with it.
        document["approvedDifferences"] = new JsonArray([.. generation.ApprovedDifferences
            .Where(record => expectations.ContainsKey(record!["journey"]!.GetValue<string>())).Select(record => record!.DeepClone())]);
        var arazzo = JsonNode.Parse(ArazzoJsonWriter.Write(Document(options.Name, workflows), true))!;
        return new JourneyDocument(options.Name, options.FileName, "code", arazzo, document);
    }

    private JourneyDocument? BuildFile(JourneyFile file, List<string> problems, Dictionary<string, string> workflowIds)
    {
        var path = Path.Combine(environment.ContentRootPath, file.Path);
        var name = Path.GetFileName(file.Path);
        if (!File.Exists(path))
        {
            problems.Add($"{file.Path}: the file doesn't exist.");
            return null;
        }

        var read = ArazzoStringReader.Read(File.ReadAllText(path), new ArazzoReaderSettings());
        var found = read.Diagnostics.Errors.Select(error => $"{name}: {error.Path}: {error.Message}").ToList();
        if (read.Document is { } document)
        {
            found.AddRange(Validate(document).Select(problem => $"{name}: {problem}"));
            foreach (var workflow in document.Workflows ?? [])
            {
                if (!workflowIds.TryAdd(workflow.WorkflowId, name))
                {
                    found.Add($"{name}: its workflow {workflow.WorkflowId} has the ID of {workflowIds[workflow.WorkflowId]}.");
                }
            }
        }

        var expectationsPath = file.ExpectationsPath is { } given ? Path.Combine(environment.ContentRootPath, given) : SiblingExpectations(path);
        JsonNode? expectations = null;
        try
        {
            expectations = File.Exists(expectationsPath) ? JsonNode.Parse(File.ReadAllText(expectationsPath)) : null;
        }
        catch (JsonException exception)
        {
            found.Add($"{Path.GetFileName(expectationsPath)}: {exception.Message}");
        }

        if (found.Count > 0 || read.Document is null)
        {
            problems.AddRange(found);
            return null;
        }

        var fileName = FileNameOf(name);
        expectations ??= new JsonObject { ["sendproofExpectations"] = "1.0", ["arazzo"] = fileName + ".arazzo.json", ["journeys"] = new JsonObject() };
        return new JourneyDocument(read.Document.Info?.Title ?? fileName, fileName, "file",
            JsonNode.Parse(ArazzoJsonWriter.Write(read.Document, true))!, expectations);
    }

    private ArazzoDocument Document(string title, IList<ArazzoWorkflow> workflows) => new()
    {
        Arazzo = ArazzoVersion,
        Info = new ArazzoInfo { Title = title, Version = "1.0.0" },
        SourceDescriptions = [new ArazzoSourceDescription { Name = SourceName(), Url = sendproof.OpenApiUrl, Type = ArazzoSourceDescriptionType.OpenApi }],
        Workflows = workflows
    };

    private static IEnumerable<string> Validate(ArazzoDocument document) =>
        ArazzoValidator.Validate(document).Where(error => !error.IsWarning).Select(error => $"Arazzo {error.Path}: {error.Message}");

    /// <summary>The OpenAPI source's name: the API name in camel case, letters and digits only, as Arazzo names allow.</summary>
    private string SourceName()
    {
        var words = (sendproof.ApiName ?? environment.ApplicationName).Split(' ', '.', '-', '_')
            .Select(word => new string([.. word.Where(char.IsAsciiLetterOrDigit)])).Where(word => word.Length > 0).ToList();
        return words.Count == 0 ? "api"
            : string.Concat(words.Select((word, index) => index == 0 ? char.ToLowerInvariant(word[0]) + word[1..] : char.ToUpperInvariant(word[0]) + word[1..]));
    }

    /// <summary>The store id of the SQL database, as capabilities report it, from the registered preview provider.</summary>
    private string SqlStore()
    {
        using var scope = services.CreateScope();
        return scope.ServiceProvider.GetServices<IPreviewProvider>().Select(provider => provider.DatabaseSystem).FirstOrDefault(system => system is not null) ?? "sql";
    }

    /// <summary>Every named endpoint, with its Sendproof Preview mark if it has one.</summary>
    private Dictionary<string, SendproofPreviewAttribute?> Operations()
    {
        var operations = new Dictionary<string, SendproofPreviewAttribute?>(StringComparer.Ordinal);
        foreach (var endpoint in documents.Routes.SelectMany(source => source.Endpoints))
        {
            if (endpoint.Metadata.GetMetadata<IEndpointNameMetadata>()?.EndpointName is { } name)
            {
                operations.TryAdd(name, endpoint.Metadata.GetMetadata<SendproofPreviewAttribute>());
            }
        }

        return operations;
    }

    private static string SiblingExpectations(string arazzoPath)
    {
        var directory = Path.GetDirectoryName(arazzoPath)!;
        return Path.Combine(directory, FileNameOf(Path.GetFileName(arazzoPath)) + ".expect.json");
    }

    /// <summary><c>store.arazzo.json</c> and <c>store.arazzo.yaml</c> are both served as <c>store</c>.</summary>
    private static string FileNameOf(string fileName)
    {
        foreach (var suffix in new[] { ".arazzo.json", ".arazzo.yaml", ".arazzo.yml", ".json", ".yaml", ".yml" })
        {
            if (fileName.EndsWith(suffix, StringComparison.OrdinalIgnoreCase))
            {
                return fileName[..^suffix.Length];
            }
        }

        return fileName;
    }
}
