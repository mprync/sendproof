namespace DotnetConformance;

/// <summary>The scenarios of the shared conformance fixture contract.</summary>
public enum FixtureScenario
{
    /// <summary>Workbench, EF preview provider and observed send are enabled.</summary>
    Standard,
    /// <summary>The application runs outside the workbench's configured environments.</summary>
    Disabled,
    /// <summary>No preview provider is registered.</summary>
    NoProvider,
    /// <summary>The preview provider fails every rollback after capturing changes.</summary>
    RollbackFailure
}

/// <summary>Runtime configuration read from the variables the conformance runner sets.</summary>
/// <param name="Port">The loopback port to listen on.</param>
/// <param name="PathBase">The application mount: empty or a single-level path such as <c>/tenant</c>.</param>
/// <param name="Scenario">The fixture scenario.</param>
/// <param name="TraceTtl">The real-time lifetime of an observed send trace.</param>
public sealed record FixtureOptions(int Port, string PathBase, FixtureScenario Scenario, TimeSpan TraceTtl)
{
    /// <summary>The adapter's fixed trace lifetime, which the fixture's scaled clock compresses.</summary>
    public static readonly TimeSpan AdapterTraceLifetime = TimeSpan.FromMinutes(5);

    /// <summary>Reads and validates the process environment, throwing a descriptive error for bad values.</summary>
    public static FixtureOptions FromEnvironment()
    {
        var port = int.TryParse(Environment.GetEnvironmentVariable("PORT"), out var parsed) && parsed is > 0 and <= 65535
            ? parsed
            : throw new InvalidOperationException("PORT must be an integer from 1 to 65535.");
        var pathBase = Environment.GetEnvironmentVariable("BENCH_PATH_BASE") ?? "";
        if (pathBase.Length > 0 && (!pathBase.StartsWith('/') || pathBase.EndsWith('/') || pathBase.Contains("//")))
            throw new InvalidOperationException("BENCH_PATH_BASE must be empty or start with '/' and not end with '/'.");
        var scenario = (Environment.GetEnvironmentVariable("BENCH_SCENARIO") ?? "standard") switch
        {
            "standard" => FixtureScenario.Standard,
            "disabled" => FixtureScenario.Disabled,
            "no-provider" => FixtureScenario.NoProvider,
            "rollback-failure" => FixtureScenario.RollbackFailure,
            var other => throw new InvalidOperationException(
                $"BENCH_SCENARIO must be standard, disabled, no-provider or rollback-failure, not '{other}'.")
        };
        var ttl = double.TryParse(Environment.GetEnvironmentVariable("BENCH_TRACE_TTL_SECONDS"),
            System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var seconds) && seconds > 0
            ? TimeSpan.FromSeconds(seconds)
            : TimeSpan.FromSeconds(5);
        return new FixtureOptions(port, pathBase, scenario, ttl);
    }
}
