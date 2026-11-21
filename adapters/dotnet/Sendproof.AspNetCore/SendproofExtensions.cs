using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging;

namespace Sendproof.AspNetCore;

/// <summary>Registers and maps the Sendproof workbench and preview integration.</summary>
public static class SendproofExtensions
{
    private static readonly SendproofPreviewAttribute PreviewMetadata = new();

    /// <summary>Adds Sendproof services. The workbench is enabled in Development by default.</summary>
    public static SendproofBuilder AddSendproof(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);
        var options = services.LastOrDefault(descriptor => descriptor.ServiceType == typeof(SendproofOptions))?.ImplementationInstance as SendproofOptions;
        if (options is null)
        {
            options = new SendproofOptions();
            services.AddSingleton(options);
            services.TryAddScoped<SendproofPreview>();
            services.TryAddSingleton<CaptureContext>();
            services.TryAddSingleton<ObservedTraceStore>();
            services.TryAddEnumerable(ServiceDescriptor.Singleton<ILoggerProvider, CaptureLoggerProvider>());
            services.TryAddEnumerable(ServiceDescriptor.Singleton<IStartupFilter, PreviewStartupFilter>());
            services.TryAddEnumerable(ServiceDescriptor.Singleton<MatcherPolicy, PreviewEndpointPolicy>());
        }

        return new SendproofBuilder(services, options);
    }

    /// <summary>Maps Sendproof under /sendproof in the configured environments.</summary>
    public static void MapSendproof(this WebApplication app)
    {
        ArgumentNullException.ThrowIfNull(app);
        var options = app.Services.GetRequiredService<SendproofOptions>();
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
    /// <para>
    /// <c>.WithSendproofPreview(enabled: false, reason: "Clears the Redis session")</c> marks the operation
    /// <c>preview: false</c> instead: the workbench explains why Preview is unavailable before anyone runs it, and the
    /// handler never runs in a Preview. <paramref name="stores"/> optionally names the store ids it writes to.
    /// </para>
    /// </remarks>
    public static TBuilder WithSendproofPreview<TBuilder>(this TBuilder endpoint, bool enabled = true, string? reason = null,
        params string[] stores) where TBuilder : IEndpointConventionBuilder
    {
        ArgumentNullException.ThrowIfNull(endpoint);
        if (enabled && stores.Length == 0 && reason is null)
        {
            return endpoint.WithMetadata(PreviewMetadata);
        }

        return endpoint.WithMetadata(new SendproofPreviewAttribute
        {
            Enabled = enabled,
            Reason = reason,
            Stores = stores.Length == 0 ? null : stores
        });
    }
}
