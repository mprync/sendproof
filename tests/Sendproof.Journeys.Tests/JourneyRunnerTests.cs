using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Sendproof.Journeys.Testing;
using Xunit;

namespace Sendproof.Journeys.Tests;

/// <summary>The runner the test suite uses: binds, runs and compares steps from the served documents.</summary>
public sealed class JourneyRunnerTests
{
    [Fact]
    public async Task A_Preview_run_holds_one_session_and_passes_with_an_approved_difference()
    {
        await using var host = await Host();

        var result = await new JourneyRunner(host.Client).RunAsync("relabelParcel");

        Assert.True(result.Passed, result.Report());
        Assert.Equal(JourneyRunMode.Preview, result.Mode);
        Assert.Equal(["passed", "passed-approved"], result.Steps.Select(step => step.Verdict));
        Assert.Equal(["AD-0001"], result.ApprovedUsed);
        var register = result.Steps[0].Findings;
        Assert.Equal(["match", "unchecked", "match"], register.Select(finding => finding.Kind));
        Assert.Equal("Sendproof doesn't hook mongodb in this host", register[1].Note);
        // Step 2 relabelled the row step 1 wrote in the same session, and nothing was committed.
        Assert.Equal(200, result.Steps[1].HttpStatus);
        Assert.Equal(0, await CountAsync(host));
    }

    [Fact]
    public async Task A_difference_without_a_record_fails_its_step_and_says_what_differs()
    {
        await using var host = await Host();

        var result = await new JourneyRunner(host.Client).RunAsync("relabelParcel", inputs: new JsonObject { ["newLabel"] = "Green box" });

        Assert.False(result.Passed);
        var relabel = result.Steps[1];
        Assert.Equal("failed", relabel.Status);
        Assert.Equal("$response.body#/label == 'Red box'", Assert.Single(relabel.Criteria, criterion => !criterion.Passed).Condition);
        var finding = Assert.Single(relabel.Findings);
        Assert.Equal("differs", finding.Kind);
        Assert.Equal("Label", Assert.Single(finding.Fields, field => field.State == "differs").Name);
        Assert.Contains("criterion failed: $response.body#/label == 'Red box' (read \"Green box\")", result.Report());
    }

    [Fact]
    public async Task A_Send_only_journey_is_sent_only_when_allowed()
    {
        await using var host = await Host();

        var refused = await new JourneyRunner(host.Client).RunAsync("cacheParcel");
        Assert.False(refused.Passed);
        Assert.Equal(JourneyRunMode.Send, refused.Mode);
        Assert.Equal("skipped", Assert.Single(refused.Steps).Status);
        Assert.Equal(0, await CountAsync(host));

        var sent = await new JourneyRunner(host.Client) { AllowSend = true }.RunAsync("cacheParcel");
        Assert.True(sent.Passed, sent.Report());
        Assert.Equal("Send only: Step register writes to Redis, which can't roll back.", sent.Notes[0]);
        Assert.Equal("unchecked", Assert.Single(sent.Steps[0].Findings).Kind);
        Assert.Equal(1, await CountAsync(host));
    }

    [Fact]
    public async Task The_runner_lists_every_published_journey()
    {
        await using var host = await Host();

        Assert.Equal(["relabelParcel", "cacheParcel"], await new JourneyRunner(host.Client).ListAsync());
    }

    private static Task<ParcelHost> Host() => ParcelHost.StartAsync(sendproof => sendproof
        .AddJourney<RelabelParcelJourney>(journeys => journeys.MapCollection<ParcelEventDocument>("parcel_events"))
        .AddJourney<CacheParcelJourney>());

    private static async Task<int> CountAsync(ParcelHost host)
    {
        using var scope = host.App.Services.CreateScope();
        return await scope.ServiceProvider.GetRequiredService<ParcelDbContext>().Parcels.CountAsync();
    }
}
