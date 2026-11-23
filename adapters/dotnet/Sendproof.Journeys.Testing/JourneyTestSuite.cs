using System.Reflection;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Xunit;

namespace Sendproof.Journeys.Testing;

/// <summary>
/// Runs every journey defined in the app's assembly as an xUnit test case, in memory through
/// <see cref="WebApplicationFactory{TEntryPoint}"/>, with Preview by default. Each journey gets a host of its own.
/// <code>
/// public sealed class JourneyTests : JourneyTestSuite&lt;StoreApplication&gt;
/// {
/// }
/// </code>
/// </summary>
/// <typeparam name="TEntryPoint">Any class in the app's assembly; the factory starts that assembly's entry point.</typeparam>
public abstract class JourneyTestSuite<TEntryPoint> where TEntryPoint : class
{
    /// <summary>Gets the IDs of the journeys defined in code in the app's assembly, one test case each.</summary>
    public static TheoryData<string> Journeys
    {
        get
        {
            var data = new TheoryData<string>();
            foreach (var type in typeof(TEntryPoint).Assembly.GetTypes().Where(type =>
                type is { IsAbstract: false, IsGenericTypeDefinition: false } && type.IsSubclassOf(typeof(Journey)) && type.GetConstructor(Type.EmptyTypes) is not null))
            {
                data.Add(((Journey)Activator.CreateInstance(type)!).Describe().Id);
            }

            return data;
        }
    }

    /// <summary>Gets the mode each journey runs in. Send-only journeys are sent whatever the mode.</summary>
    protected virtual JourneyRunMode Mode => JourneyRunMode.Preview;

    /// <summary>
    /// Gets whether journeys may send for real: Send-only ones, and every one when the host can't hold a Preview
    /// session. Turn it on only when <see cref="ConfigureWebHost"/> points the app at a throwaway database.
    /// </summary>
    protected virtual bool AllowSend => false;

    /// <summary>Runs one journey and fails with its report when a step fails.</summary>
    [Theory]
    [MemberData(nameof(Journeys))]
    public async Task Journey(string journeyId)
    {
        var result = await RunAsync(journeyId);
        Assert.True(result.Passed, result.Report());
    }

    /// <summary>Runs one journey on a host of its own and returns its result.</summary>
    /// <param name="journeyId">The journey.</param>
    /// <param name="inputs">Values for its inputs; <see cref="Inputs"/> gives them when left out.</param>
    public async Task<JourneyRunResult> RunAsync(string journeyId, JsonObject? inputs = null)
    {
        await using var factory = new WebApplicationFactory<TEntryPoint>();
        await using var configured = factory.WithWebHostBuilder(ConfigureWebHost);
        using var client = configured.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false, HandleCookies = true });
        return await new JourneyRunner(client) { AllowSend = AllowSend }.RunAsync(journeyId, Mode, inputs ?? Inputs(journeyId));
    }

    /// <summary>Configures the app's host for the tests, such as pointing it at a throwaway database.</summary>
    protected virtual void ConfigureWebHost(IWebHostBuilder builder)
    {
    }

    /// <summary>Values for a journey's inputs; the rest come from its inputs class's defaults.</summary>
    protected virtual JsonObject? Inputs(string journeyId) => null;
}
