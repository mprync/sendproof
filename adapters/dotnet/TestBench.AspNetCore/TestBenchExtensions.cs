using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging;

namespace TestBench.AspNetCore;

/// <summary>Registers and maps the Test Bench workbench and preview integration.</summary>
public static class TestBenchExtensions
{
    private static readonly TestBenchPreviewAttribute PreviewMetadata = new();

    /// <summary>Adds Test Bench services. The workbench is enabled in Development by default.</summary>
    public static TestBenchBuilder AddTestBench(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);
        var options = services.LastOrDefault(descriptor => descriptor.ServiceType == typeof(TestBenchOptions))?.ImplementationInstance as TestBenchOptions;
        if (options is null)
        {
            options = new TestBenchOptions();
            services.AddSingleton(options);
            services.TryAddScoped<TestBenchPreview>();
            services.TryAddSingleton<CaptureContext>();
            services.TryAddSingleton<ObservedTraceStore>();
            services.TryAddEnumerable(ServiceDescriptor.Singleton<ILoggerProvider, CaptureLoggerProvider>());
            services.TryAddEnumerable(ServiceDescriptor.Singleton<IStartupFilter, PreviewStartupFilter>());
            services.TryAddEnumerable(ServiceDescriptor.Singleton<MatcherPolicy, PreviewEndpointPolicy>());
        }

        return new TestBenchBuilder(services, options);
    }

    /// <summary>Maps Test Bench under /bench in the configured environments.</summary>
    public static void MapTestBench(this WebApplication app)
    {
        ArgumentNullException.ThrowIfNull(app);
        var options = app.Services.GetRequiredService<TestBenchOptions>();
        if (options.IsMapped)
        {
            return;
        }

        options.IsMapped = true;
        if (options.Enabled(app.Environment))
        {
            WorkbenchEndpoints.Map(app, options);
        }
    }

    /// <summary>Declares that this operation's effects are safe to run in a rollback-only preview.</summary>
    /// <remarks>
    /// The host must arrange for all writes to participate in the preview transaction and for external effects
    /// to be suppressed. Register a provider before enabling previews. Use buffered HTTP results.
    /// </remarks>
    public static TBuilder WithTestBenchPreview<TBuilder>(this TBuilder endpoint) where TBuilder : IEndpointConventionBuilder
    {
        ArgumentNullException.ThrowIfNull(endpoint);
        return endpoint.WithMetadata(PreviewMetadata);
    }
}
