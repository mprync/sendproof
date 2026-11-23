using Xunit;

namespace Sendproof.Journeys.Tests;

/// <summary>A wrong journey stops startup in Development with every problem listed; elsewhere it is logged and skipped.</summary>
public sealed class StartupValidationTests
{
    [Fact]
    public async Task A_wrong_journey_stops_startup_in_Development_with_a_readable_list()
    {
        var failure = await Assert.ThrowsAsync<JourneyValidationException>(() =>
            ParcelHost.StartAsync(sendproof => sendproof.AddJourney<WrongJourney>().AddJourney<RelabelParcelJourney>()));

        Assert.Equal(5, failure.Problems.Count);
        Assert.Equal("WrongJourney: Step relabel: r.Id uses the output parcel.Id of step read, which comes later in the journey.", failure.Problems[0]);
        Assert.Equal("WrongJourney: Two steps have the ID read.", failure.Problems[1]);
        Assert.Equal("WrongJourney: UnmappedRow is not an entity of ParcelDbContext.", failure.Problems[2]);
        // Bielu.Arazzo's validator checks the generated workflow too, and names the step it read twice.
        Assert.StartsWith("WrongJourney: Arazzo /workflows/0/steps/2: ", failure.Problems[3]);
        Assert.Contains("read", failure.Problems[3]);
        // The good journey's MongoDB document needs its collection registered too.
        Assert.Equal("RelabelParcelJourney: No collection is registered for ParcelEventDocument: add journeys.MapCollection<ParcelEventDocument>(\"…\").",
            failure.Problems[4]);
        Assert.StartsWith("Sendproof found 5 problems in the journeys:" + Environment.NewLine + "- WrongJourney: Step relabel", failure.Message);
    }

    [Fact]
    public async Task Elsewhere_a_wrong_journey_is_skipped_and_the_rest_are_served()
    {
        await using var host = await ParcelHost.StartAsync(sendproof => sendproof.AddJourney<WrongJourney>().AddJourney<CacheParcelJourney>(), "Staging");

        var arazzo = await host.Client.GetStringAsync("/sendproof/journeys/journeys.arazzo.json");
        Assert.Contains("cacheParcel", arazzo);
        Assert.DoesNotContain("wrong", arazzo);
    }

    [Fact]
    public async Task The_workbench_engine_modules_under_journeys_are_not_shadowed_by_the_documents()
    {
        await using var host = await ParcelHost.StartAsync(sendproof => sendproof.AddJourney<CacheParcelJourney>(), "Staging");

        // The workbench imports ui/journeys/*.js from /sendproof/journeys/, beside the served documents.
        using var engine = await host.Client.GetAsync("/sendproof/journeys/index.js");
        Assert.Equal(System.Net.HttpStatusCode.OK, engine.StatusCode);
        Assert.Contains("compareStep", await engine.Content.ReadAsStringAsync());
        using var missing = await host.Client.GetAsync("/sendproof/journeys/other.arazzo.json");
        Assert.Equal(System.Net.HttpStatusCode.NotFound, missing.StatusCode);
    }

    [Fact]
    public async Task Two_journeys_with_one_ID_and_a_ref_from_another_journey_are_problems()
    {
        var failure = await Assert.ThrowsAsync<JourneyValidationException>(() =>
            ParcelHost.StartAsync(sendproof => sendproof.AddJourney<BorrowingJourney>().AddJourney<CacheParcelJourney>().AddJourney<CacheParcelAgainJourney>()));

        Assert.Contains("BorrowingJourney: Step register: r.Body.Label uses input i.Label, which belongs to another journey.", failure.Problems);
        Assert.Contains("CacheParcelAgainJourney: Its ID cacheParcel is also the ID of CacheParcelJourney.", failure.Problems);
    }

    [Fact]
    public async Task A_step_calling_an_operation_no_endpoint_is_named_is_a_problem()
    {
        var failure = await Assert.ThrowsAsync<JourneyValidationException>(() =>
            ParcelHost.StartAsync(sendproof => sendproof.AddJourney<GhostJourney>()));

        Assert.Equal(["GhostJourney: Step haunt: no mapped endpoint is named ParcelsController.Haunt."], failure.Problems);
    }

    /// <summary>Uses a ref another journey's builder made, through a static field.</summary>
    public sealed class BorrowingJourney : Journey<ParcelInputs>
    {
        private static Ref<string>? s_borrowed;

        protected override void Define(JourneyBuilder<ParcelInputs> journey)
        {
            s_borrowed ??= new JourneyBuilder<ParcelInputs>(typeof(CacheParcelJourney)).Input(i => i.Label);
            var register = journey.Step("register", ParcelOperations.Parcels.Register);
            register.Set(r => r.Body.Label, s_borrowed);
        }
    }

    /// <summary>Has the ID of <see cref="CacheParcelJourney"/>.</summary>
    public sealed class CacheParcelAgainJourney : Journey<ParcelInputs>
    {
        protected override void Define(JourneyBuilder<ParcelInputs> journey)
        {
            journey.Id("cacheParcel");
            journey.Step("register", ParcelOperations.Parcels.Register).SucceedsWith(201);
        }
    }

    /// <summary>Calls an operation the app doesn't map.</summary>
    public sealed class GhostJourney : Journey<ParcelInputs>
    {
        protected override void Define(JourneyBuilder<ParcelInputs> journey) =>
            journey.Step("haunt", new JourneyOperation<object, object>("ParcelsController.Haunt", "POST")).SucceedsWith(200);
    }
}
