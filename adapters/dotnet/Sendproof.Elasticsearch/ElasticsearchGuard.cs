using System.Text;
using Elastic.Clients.Elasticsearch;
using Elastic.Transport;
using Sendproof.AspNetCore;

namespace Sendproof.Elasticsearch;

/// <summary>
/// The Elasticsearch write guard: a decorator over the client's <see cref="ITransport{TConfiguration}"/>, which every typed
/// call, namespaced client and helper goes through. It sees the HTTP method and path of each request before the transport
/// builds or sends it, so a refused write never reaches the pipeline, and the refusal reaches the handler as a
/// <see cref="PreviewWriteBlockedException"/> rather than wrapped by the transport. Classification follows
/// spec/data-stores/elasticsearch.json.
/// </summary>
internal sealed class ElasticsearchGuard(CaptureContext capture, IReadOnlySet<string>? treatAsRead)
{
    /// <summary>The store id in <c>Db</c> entries and the 409 body.</summary>
    internal const string Store = "elasticsearch";

    /// <summary>Wraps a transport in the guard. A transport that is already guarded by this guard is returned as it is.</summary>
    internal ITransport<IElasticsearchClientSettings> Guard(ITransport<IElasticsearchClientSettings> inner) =>
        inner is GuardedTransport { Owner: var owner } && ReferenceEquals(owner, this) ? inner : new GuardedTransport(this, inner);

    /// <summary>Whether a client's transport is guarded by <paramref name="guard"/>.</summary>
    internal static bool IsGuarded(ElasticsearchClient client, ElasticsearchGuard guard) =>
        client.Transport is GuardedTransport { Owner: var owner } && ReferenceEquals(owner, guard);

    /// <summary>Reads the body of a request as text, for the SQL endpoints and the logged statement. Unreadable bodies are null.</summary>
    private static string? BodyOf(PostData? data, ITransportConfiguration configuration)
    {
        if (data is null || data.Type is PostType.StreamHandler or PostType.Pipe)
        {
            return null;
        }

        try
        {
            using var stream = new MemoryStream();
            data.Write(stream, configuration, false);
            return Encoding.UTF8.GetString(stream.ToArray());
        }
        catch (Exception error) when (error is not OutOfMemoryException)
        {
            return null;
        }
    }

    private sealed class GuardedTransport(ElasticsearchGuard guard, ITransport<IElasticsearchClientSettings> inner) : ITransport<IElasticsearchClientSettings>
    {
        internal ElasticsearchGuard Owner => guard;

        public IElasticsearchClientSettings Configuration => inner.Configuration;

        ITransportConfiguration ITransport.Configuration => inner.Configuration;

        public TResponse Request<TResponse>(in EndpointPath path, PostData? data, Action<System.Diagnostics.Activity>? openTelemetryData, IRequestConfiguration? localConfiguration)
            where TResponse : TransportResponse, new()
        {
            var call = guard.Begin(path, data, inner.Configuration);
            try
            {
                var response = inner.Request<TResponse>(in path, data, openTelemetryData, localConfiguration);
                guard.Finish(call, response);
                return response;
            }
            catch (Exception error)
            {
                call.Fail(error);
                throw;
            }
        }

        // An async method can't take an `in` parameter, so the path is copied into the one that awaits.
        public Task<TResponse> RequestAsync<TResponse>(in EndpointPath path, PostData? data, Action<System.Diagnostics.Activity>? openTelemetryData, IRequestConfiguration? localConfiguration, CancellationToken cancellationToken = default)
            where TResponse : TransportResponse, new() =>
            RequestCoreAsync<TResponse>(path, data, openTelemetryData, localConfiguration, cancellationToken);

        private async Task<TResponse> RequestCoreAsync<TResponse>(EndpointPath path, PostData? data, Action<System.Diagnostics.Activity>? openTelemetryData, IRequestConfiguration? localConfiguration, CancellationToken cancellationToken)
            where TResponse : TransportResponse, new()
        {
            var call = guard.Begin(path, data, inner.Configuration);
            try
            {
                var response = await inner.RequestAsync<TResponse>(in path, data, openTelemetryData, localConfiguration, cancellationToken).ConfigureAwait(false);
                guard.Finish(call, response);
                return response;
            }
            catch (Exception error)
            {
                call.Fail(error);
                throw;
            }
        }
    }

    private DbCall Begin(EndpointPath path, PostData? data, ITransportConfiguration configuration) =>
        SearchCall.Begin(capture, Store, path.Method.ToString(), path.PathAndQuery, () => BodyOf(data, configuration), treatAsRead);

    /// <summary>Logs a finished request. A reply with an error status is logged with that status as its error.</summary>
    private void Finish(DbCall call, TransportResponse response)
    {
        if (response.ApiCallDetails?.HttpStatusCode is >= 400 and var status)
        {
            call.Fail(new HttpRequestException(status.ToString()), status.ToString());
            return;
        }

        call.Succeed();
    }
}
