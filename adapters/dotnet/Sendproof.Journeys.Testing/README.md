# Sendproof.Journeys.Testing

Runs every [Sendproof journey](../Sendproof.Journeys/README.md) as an xUnit test case, in memory through
`WebApplicationFactory`, with Preview by default: all of a journey's steps run in one held Preview session, so a later
step sees what an earlier one wrote, and nothing is committed. Each step's success criteria are checked and its writes
compared with the expectations document, as the workbench and `sendproof journeys run` do.

## Use it

```csharp
public sealed class JourneyTests : JourneyTestSuite<StoreApplication>
{
}
```

- `TEntryPoint` is any class in the app's assembly; the suite lists the journeys defined in that assembly, one test
  case each, and starts the app's own entry point for each one.
- Reference `Microsoft.AspNetCore.Mvc.Testing` from the test project too: its build targets record the app's content root.
- A failing journey fails its test with a report: each step's status, the criteria that failed, and each write that
  differs, is missing or is extra.

## Sending for real

Send-only journeys (they write to Redis, say) are sent, and so is every journey when the host can't hold Preview
sessions. The suite refuses to send unless you say so, so it never writes to a development database by accident:

```csharp
public sealed class JourneyTests : JourneyTestSuite<StoreApplication>, IDisposable
{
    private readonly DirectoryInfo _directory = Directory.CreateTempSubdirectory("store-journeys-");

    protected override bool AllowSend => true;

    protected override void ConfigureWebHost(IWebHostBuilder builder) =>
        builder.UseSetting("DemoDatabasePath", Path.Combine(_directory.FullName, "store.db"));

    public void Dispose() => _directory.Delete(recursive: true);
}
```

Override `Mode` to send every journey, and `Inputs(journeyId)` to give inputs other than the defaults.
`RunAsync(journeyId, inputs)` runs one journey and returns its `JourneyRunResult` for your own assertions.

## The runner on its own

`JourneyRunner` runs a journey against any `HttpClient` that reaches a Sendproof host: it reads capabilities, the
Arazzo and expectations documents and the OpenAPI document, signs in as the journey's persona through the personas
provider, and runs each step.

```csharp
var result = await new JourneyRunner(client).RunAsync("orderToShipment", inputs: new JsonObject { ["quantity"] = 2 });
Console.WriteLine(result.Report());
```

## Libraries

Bielu.Arazzo.NET (MIT) reads the Arazzo document and evaluates runtime expressions; Microsoft.OpenApi reads the
OpenAPI document; JsonPath.Net (MIT) evaluates JSONPath criteria. The simple-condition parser and the write comparison
are the package's own: no library covers Sendproof's expectations.
