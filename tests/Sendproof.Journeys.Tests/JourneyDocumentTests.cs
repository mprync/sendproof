using System.Text.Json;
using System.Text.Json.Nodes;
using Json.Schema;
using Xunit;

namespace Sendproof.Journeys.Tests;

/// <summary>
/// The documents a host publishes: valid Arazzo 1.1 (checked against the OpenAPI Initiative's published schema), the
/// expectations document of contract 2, and their discovery in capabilities.
/// </summary>
public sealed class JourneyDocumentTests
{
    private static readonly JsonSchema ArazzoSchema = JsonSchema.FromFile(Path.Combine(AppContext.BaseDirectory, "Schemas", "arazzo-1.1-2026-04-15.schema.json"));

    [Fact]
    public async Task Code_journeys_are_served_as_valid_Arazzo_1_1_and_listed_in_capabilities()
    {
        await using var host = await ParcelHost.StartAsync(sendproof => sendproof
            .AddJourney<RelabelParcelJourney>(journeys => journeys.MapCollection<ParcelEventDocument>("parcel_events"))
            .AddJourney<CacheParcelJourney>(journeys => { journeys.Name = "Parcel journeys"; journeys.FileName = "parcels"; }));

        var capabilities = await Json(host, "/sendproof/_api/capabilities");
        var entry = Assert.Single(capabilities["journeys"]!.AsArray());
        Assert.Equal("Parcel journeys", entry!["name"]!.GetValue<string>());
        Assert.Equal("/sendproof/journeys/parcels.arazzo.json", entry["arazzoUrl"]!.GetValue<string>());
        Assert.Equal("/sendproof/journeys/parcels.expect.json", entry["expectationsUrl"]!.GetValue<string>());
        Assert.Equal("code", entry["source"]!.GetValue<string>());

        var arazzo = await Json(host, "/sendproof/journeys/parcels.arazzo.json");
        var evaluation = ArazzoSchema.Evaluate(Element(arazzo), new EvaluationOptions { OutputFormat = OutputFormat.List });
        Assert.True(evaluation.IsValid, string.Join("; ", (evaluation.Details ?? []).Where(detail => detail.Errors is not null)
            .Select(detail => $"{detail.InstanceLocation}: {string.Join(", ", detail.Errors!.Values)}")));
        Assert.Equal("1.1.0", arazzo["arazzo"]!.GetValue<string>());
        Assert.Equal("/openapi/v1.json", arazzo["sourceDescriptions"]![0]!["url"]!.GetValue<string>());

        var workflow = arazzo["workflows"]![0]!;
        Assert.Equal("relabelParcel", workflow["workflowId"]!.GetValue<string>());
        Assert.Equal("object", workflow["inputs"]!["type"]!.GetValue<string>());
        Assert.Equal("The label the parcel is registered with.", workflow["inputs"]!["properties"]!["label"]!["description"]!.GetValue<string>());
        Assert.Equal("Blue box", workflow["inputs"]!["properties"]!["label"]!["default"]!.GetValue<string>());
        var register = workflow["steps"]![0]!;
        Assert.Equal("ParcelsController.Register", register["operationId"]!.GetValue<string>());
        Assert.Equal("$inputs.label", register["requestBody"]!["payload"]!["label"]!.GetValue<string>());
        Assert.True(register["requestBody"]!["payload"]!["notifyOwner"]!.GetValue<bool>());
        Assert.Equal("$response.body#/id", register["outputs"]!["parcelId"]!.GetValue<string>());
        var relabel = workflow["steps"]![1]!;
        Assert.Equal("path", relabel["parameters"]![0]!["in"]!.GetValue<string>());
        Assert.Equal("$steps.register.outputs.parcelId", relabel["parameters"]![0]!["value"]!.GetValue<string>());
        Assert.Equal("$response.body#/label == 'Red box'", relabel["successCriteria"]![1]!["condition"]!.GetValue<string>());

        var expectations = await Json(host, "/sendproof/journeys/parcels.expect.json");
        Assert.Equal("1.0", expectations["sendproofExpectations"]!.GetValue<string>());
        Assert.Equal("parcels.arazzo.json", expectations["arazzo"]!.GetValue<string>());
        var journey = expectations["journeys"]!["relabelParcel"]!;
        Assert.Equal("Parcels", journey["group"]!.GetValue<string>());
        Assert.Equal("RelabelParcelJourney", journey["definedIn"]!["type"]!.GetValue<string>());
        Assert.Equal("Parcels/RelabelParcelJourney.cs", journey["definedIn"]!["file"]!.GetValue<string>());
        var writes = journey["steps"]!["register"]!["writes"]!.AsArray();
        // The table is the model's name for it, and the store the SQL provider's id, as capabilities report it.
        Assert.Equal("""{"store":"sqlite","table":"parcel_rows","op":"insert","values":{"Id":"$steps.register.outputs.parcelId","Label":"$inputs.label","Status":"Registered","CreatedAt":{"type":"date-time"}}}""",
            writes[0]!.ToJsonString());
        // The collection is the registered one, and the fields the class map's element names.
        Assert.Equal("""{"store":"mongodb","collection":"parcel_events","op":"insert","values":{"parcel_id":"$steps.register.outputs.parcelId","kind":"parcel.registered"}}""",
            writes[1]!.ToJsonString());
        Assert.Equal("""[{"kind":"email","to":"owner@example.test","subject":{"pattern":"registered$"}}]""",
            journey["steps"]!["register"]!["effects"]!.ToJsonString());
        Assert.Equal("""{"from":"Blue box","to":"Red box"}""", journey["steps"]!["relabel"]!["writes"]![0]!["values"]!["Label"]!.ToJsonString());

        var approved = Assert.Single(expectations["approvedDifferences"]!.AsArray())!;
        Assert.Equal("""{"id":"AD-0001","journey":"relabelParcel","step":"relabel","target":{"store":"sqlite","table":"parcel_rows","field":"Status"},"kind":"value","expected":"Relabeled","actual":"Relabelled","reason":"The API spells it the British way; the expectation was written the American way.","approvedBy":"sam.support@example.test","approvedOn":"2026-11-01","expires":"2099-12-31"}""",
            approved.ToJsonString());

        var cache = expectations["journeys"]!["cacheParcel"]!;
        Assert.True(cache["sendOnly"]!.GetValue<bool>());
        Assert.Equal("Step register writes to Redis, which can't roll back.", cache["sendOnlyReason"]!.GetValue<string>());
        Assert.Equal("""{"store":"redis","key":"parcel:{$steps.register.outputs.parcelId}","op":"SET","values":{"expiry":{"type":"any"}}}""",
            cache["steps"]!["register"]!["writes"]![0]!.ToJsonString());
    }

    [Fact]
    public async Task Urls_include_the_path_base()
    {
        await using var host = await ParcelHost.StartAsync(sendproof => sendproof.AddJourney<CacheParcelJourney>(), pathBase: "/tenant");

        var capabilities = await Json(host, "/tenant/sendproof/_api/capabilities");
        Assert.Equal("/tenant/sendproof/journeys/journeys.arazzo.json", capabilities["journeys"]![0]!["arazzoUrl"]!.GetValue<string>());
        var arazzo = await Json(host, "/tenant/sendproof/journeys/journeys.arazzo.json");
        Assert.Equal("/tenant/openapi/v1.json", arazzo["sourceDescriptions"]![0]!["url"]!.GetValue<string>());
    }

    [Fact]
    public async Task A_registered_Arazzo_file_is_served_with_source_file()
    {
        await using var host = await ParcelHost.StartAsync(sendproof => sendproof.WithJourneys("journeys/hand.arazzo.json"));

        var entry = (await Json(host, "/sendproof/_api/capabilities"))["journeys"]![0]!;
        Assert.Equal("Hand-written journeys", entry["name"]!.GetValue<string>());
        Assert.Equal("file", entry["source"]!.GetValue<string>());
        var arazzo = await Json(host, entry["arazzoUrl"]!.GetValue<string>());
        Assert.True(ArazzoSchema.Evaluate(Element(arazzo)).IsValid);
        Assert.Equal("registerByHand", arazzo["workflows"]![0]!["workflowId"]!.GetValue<string>());
        Assert.Equal("""{"sendproofExpectations":"1.0","arazzo":"hand.arazzo.json","journeys":{}}""",
            (await Json(host, entry["expectationsUrl"]!.GetValue<string>())).ToJsonString());
    }

    [Fact]
    public async Task Hosts_without_journeys_leave_them_out_of_capabilities()
    {
        await using var host = await ParcelHost.StartAsync(_ => { });

        Assert.Null((await Json(host, "/sendproof/_api/capabilities"))["journeys"]);
    }

    private static JsonElement Element(JsonNode node) => JsonSerializer.SerializeToElement(node);

    private static async Task<JsonNode> Json(ParcelHost host, string url)
    {
        using var response = await host.Client.GetAsync(url);
        var text = await response.Content.ReadAsStringAsync();
        Assert.True(response.IsSuccessStatusCode, $"{url}: {(int)response.StatusCode} {text}");
        return JsonNode.Parse(text)!;
    }
}
