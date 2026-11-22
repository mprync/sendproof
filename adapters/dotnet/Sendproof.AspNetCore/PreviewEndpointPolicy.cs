using System.Runtime.CompilerServices;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.OutputCaching;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.Routing.Matching;
using Microsoft.Extensions.DependencyInjection;

namespace Sendproof.AspNetCore;

// Keep the real route values and metadata. Authorization, filters and parameter binding
// therefore run against the endpoint selected by the host's normal routing rules.
internal sealed class PreviewEndpointPolicy(SendproofOptions options) : MatcherPolicy, IEndpointSelectorPolicy
{
    private readonly ConditionalWeakTable<Endpoint, Endpoint> _wrappedEndpoints = new();
    private readonly ConditionalWeakTable<Endpoint, Endpoint> _observedEndpoints = new();

    public override int Order => int.MaxValue;

    public bool AppliesToEndpoints(IReadOnlyList<Endpoint> endpoints) => endpoints.Count > 0;

    public Task ApplyAsync(HttpContext context, CandidateSet candidates)
    {
        var isPreview = context.Features.Get<PreviewRequest>() is not null;
        if (!isPreview && context.Features.Get<ObservedRequest>() is null)
        {
            return Task.CompletedTask;
        }

        for (var i = 0; i < candidates.Count; i++)
        {
            if (candidates.IsValidCandidate(i))
            {
                var candidate = candidates[i];
                if (isPreview)
                {
                    candidates.ReplaceEndpoint(i, _wrappedEndpoints.GetValue(candidate.Endpoint, Wrap), candidate.Values);
                }
                else if (candidate.Endpoint.RequestDelegate is not null && candidate.Endpoint is RouteEndpoint &&
                    candidate.Endpoint.Metadata.GetMetadata<SendproofPreviewAttribute>() is not null &&
                    candidate.Endpoint.Metadata.GetMetadata<IHttpMethodMetadata>()?.HttpMethods
                        .Contains(context.Request.Method, StringComparer.OrdinalIgnoreCase) == true)
                {
                    candidates.ReplaceEndpoint(i, _observedEndpoints.GetValue(candidate.Endpoint, WrapObserved), candidate.Values);
                }
            }
        }

        return Task.CompletedTask;
    }

    /// <summary>The data stores the host hooked, in registration order.</summary>
    internal static IReadOnlyList<IPreviewDataStore> GetDataStores(HttpContext context) =>
        [.. context.RequestServices.GetServices<IPreviewDataStore>()];

    /// <summary>The first store that makes every Preview unavailable, with its reason, or <see langword="null"/>.</summary>
    internal static (string Store, string Reason)? Blocked(IReadOnlyList<IPreviewDataStore> stores)
    {
        foreach (var store in stores)
        {
            if (store is IPreviewBlocker { PreviewBlockedReason: { } reason })
            {
                return (store.System, reason);
            }
        }

        return null;
    }

    internal static IPreviewProvider? GetProvider(HttpContext context)
    {
        using var providers = context.RequestServices.GetServices<IPreviewProvider>().GetEnumerator();
        if (!providers.MoveNext())
        {
            return null;
        }

        var provider = providers.Current;
        return providers.MoveNext() || !provider.IsAvailable ? null : provider;
    }

    private Endpoint WrapObserved(Endpoint endpoint)
    {
        var route = (RouteEndpoint)endpoint;
        var metadata = new EndpointMetadataCollection(endpoint.Metadata.Append(new OutputCacheAttribute { NoStore = true }));
        return new RouteEndpoint(context => ObservedSend.ExecuteAsync(context, endpoint.RequestDelegate!, options),
            route.RoutePattern, route.Order, metadata, route.DisplayName);
    }

    private Endpoint Wrap(Endpoint endpoint)
    {
        IEnumerable<object> metadata = endpoint.Metadata;
        if (options.AuthorizationPolicy is { } policy)
        {
            if (endpoint.Metadata.GetMetadata<IAllowAnonymous>() is not null)
            {
                metadata = metadata.Where(item => item is not (IAllowAnonymous or IAuthorizeData or AuthorizationPolicy or IAuthorizationRequirementData));
            }

            metadata = metadata.Append(new AuthorizeAttribute(policy));
        }

        var previewMetadata = new EndpointMetadataCollection(metadata.Append(new OutputCacheAttribute { NoStore = true }));
        Task Execute(HttpContext context) => ExecuteAsync(context, endpoint);
        return endpoint is RouteEndpoint route
            ? new RouteEndpoint(Execute, route.RoutePattern, route.Order, previewMetadata, route.DisplayName)
            : new Endpoint(Execute, previewMetadata, endpoint.DisplayName);
    }

    private static async Task ExecuteAsync(HttpContext context, Endpoint endpoint)
    {
        var preview = context.Features.Get<PreviewRequest>()!;
        // An operation marked Enabled = false (preview: false) is treated like an unmarked one: the handler never runs.
        if (endpoint.Metadata.GetMetadata<SendproofPreviewAttribute>() is not { Enabled: true } || endpoint.RequestDelegate is not { } execute ||
            preview.HasInvokedEndpoint || !preview.MatchesTarget(context.Request))
        {
            context.Response.StatusCode = StatusCodes.Status409Conflict;
            return;
        }

        if (!PreviewProtocol.IsSameOrigin(context.Request))
        {
            context.Response.StatusCode = StatusCodes.Status403Forbidden;
            return;
        }

        // A host with only data stores (a MongoDB-only or guard-only app) can still Preview: no SQL provider is needed.
        var provider = GetProvider(context);
        var stores = GetDataStores(context);

        // A client the guard can't cover is in use (a Cosmos DB client in bulk mode): no Preview runs its handler.
        if (Blocked(stores) is not null)
        {
            context.Response.StatusCode = StatusCodes.Status409Conflict;
            return;
        }

        if (provider is null && stores.Count == 0)
        {
            context.Response.StatusCode = StatusCodes.Status503ServiceUnavailable;
            return;
        }

        preview.HasInvokedEndpoint = true;
        preview.Clock.StartHandler();
        var recorder = context.RequestServices.GetRequiredService<SendproofPreview>();
        if (provider is not null)
        {
            preview.Session = await provider.BeginAsync(context, context.RequestAborted) ??
                throw new InvalidOperationException("The preview provider returned no session.");
        }

        recorder.Begin(rollback: true, preview.Started);
        preview.Stores = stores;
        foreach (var store in stores)
        {
            await store.BeginPreviewAsync(recorder, context.RequestAborted);
        }

        await execute(context);
        preview.EndpointCompleted = true;
    }
}
