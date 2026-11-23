using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Hosting;
using Sendproof.Journeys.Testing;
using StoreApi;
using Xunit;

/// <summary>
/// Runs every store journey as a test case, in memory, with Preview where it can. Price with a coupon is Send only (it
/// writes Redis), so each journey's host gets a throwaway database of its own, deleted afterwards.
/// </summary>
public sealed class JourneyTests : JourneyTestSuite<StoreApplication>, IDisposable
{
    private readonly DirectoryInfo _directory = Directory.CreateTempSubdirectory("store-journeys-");

    /// <inheritdoc />
    protected override bool AllowSend => true;

    /// <inheritdoc />
    protected override void ConfigureWebHost(IWebHostBuilder builder) =>
        builder.UseSetting("DemoDatabasePath", Path.Combine(_directory.FullName, "store.db"));

    [Fact]
    public async Task Order_to_shipment_fails_at_step_4_when_the_carrier_differs()
    {
        var result = await RunAsync("orderToShipment", new JsonObject { ["carrier"] = "Ups" });

        Assert.False(result.Passed);
        Assert.Equal(["passed", "passed", "passed", "failed", "passed"], result.Steps.Select(step => step.Verdict));
        var differs = result.Steps[3].Findings.Where(finding => finding.Kind == "differs").ToList();
        // The shipment has the other carrier, and AD-0011 covers only DHL's new code, not this one.
        Assert.Equal(["Shipments", "AuditEvents"], differs.Select(finding => finding.Target));
        Assert.Empty(result.ApprovedUsed);
    }

    /// <inheritdoc />
    public void Dispose()
    {
        // Pooled connections keep the database file open, and Windows will not delete an open file.
        Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
        _directory.Delete(recursive: true);
    }
}
