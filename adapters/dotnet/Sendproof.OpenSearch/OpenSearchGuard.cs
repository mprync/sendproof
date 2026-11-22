using System.Text;
using OpenSearch.Client;
using OpenSearch.Net;
using Sendproof.AspNetCore;
using HttpMethod = OpenSearch.Net.HttpMethod;

namespace Sendproof.OpenSearch;

/// <summary>
/// The OpenSearch write guard: a decorator over the client's <see cref="ITransport{TConnectionSettings}"/>, which every typed
/// call, the low-level client and the helpers go through. It sees the HTTP method and path of each request before the
/// transport builds or sends it, so a refused write never reaches the pipeline, and the refusal reaches the handler as a
/// <see cref="PreviewWriteBlockedException"/> rather than wrapped by the transport. Classification follows
/// spec/data-stores/elasticsearch.json, which covers OpenSearch's endpoints too.
/// </summary>
internal sealed class OpenSearchGuard(CaptureContext capture, IReadOnlySet<string>? treatAsRead)
{
    /// <summary>The store id in <c>Db</c> entries and the 409 body.</summary>
    internal const string Store = "opensearch";

    /// <summary>Wraps a transport in the guard. A transport that is already guarded by this guard is returned as it is.</summary>
    internal ITransport<IConnectionSettingsValues> Guard(ITransport<IConnectionSettingsValues> inner) =>
        inner is GuardedTransport { Owner: var owner } && ReferenceEquals(owner, this) ? inner : new GuardedTransport(this, inner);

    /// <summary>Whether a client's transport is guarded by <paramref name="guard"/>.</summary>
    internal static bool IsGuarded(IOpenSearchClient client, OpenSearchGuard guard) => IsGuardedTransport(TransportOf(client), guard);

    /// <summary>Whether a transport is one <paramref name="guard"/> made.</summary>
    internal static bool IsGuardedTransport(ITransport<IConnectionSettingsValues> transport, OpenSearchGuard guard) =>
        transport is GuardedTransport { Owner: var owner } && ReferenceEquals(owner, guard);

    private static readonly System.Reflection.PropertyInfo? TransportProperty = typeof(OpenSearchClient).GetProperty(
        "Transport", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic);

    /// <summary>
    /// The transport a client sends through. <see cref="OpenSearchClient"/> keeps it in a non-public property; a client the
    /// guard can't read it from (another <see cref="IOpenSearchClient"/> implementation) gets an equivalent transport built
    /// from the same settings, which is exactly what <c>new OpenSearchClient(settings)</c> would create.
    /// </summary>
    internal static ITransport<IConnectionSettingsValues> TransportOf(IOpenSearchClient client) =>
        client is OpenSearchClient && TransportProperty?.GetValue(client) is ITransport<IConnectionSettingsValues> transport
            ? transport
            : new Transport<IConnectionSettingsValues>(client.ConnectionSettings);

    /// <summary>Reads the body of a request as text, for the SQL endpoints and the logged statement. Unreadable bodies are null.</summary>
    private static string? BodyOf(PostData? data, IConnectionConfigurationValues settings)
    {
        if (data is null || data.Type is PostType.StreamHandler)
        {
            return null;
        }

        try
        {
            using var stream = new MemoryStream();
            data.Write(stream, settings);
            return Encoding.UTF8.GetString(stream.ToArray());
        }
        catch (Exception error) when (error is not OutOfMemoryException)
        {
            return null;
        }
    }

    private sealed class GuardedTransport(OpenSearchGuard guard, ITransport<IConnectionSettingsValues> inner) : ITransport<IConnectionSettingsValues>
    {
        internal OpenSearchGuard Owner => guard;

        public IConnectionSettingsValues Settings => inner.Settings;

        public TResponse Request<TResponse>(HttpMethod method, string path, PostData? data = null, IRequestParameters? requestParameters = null)
            where TResponse : class, IOpenSearchResponse, new()
        {
            var call = guard.Begin(method, path, data, inner.Settings);
            try
            {
                var response = inner.Request<TResponse>(method, path, data, requestParameters);
                guard.Finish(call, response);
                return response;
            }
            catch (Exception error)
            {
                call.Fail(error);
                throw;
            }
        }

        public async Task<TResponse> RequestAsync<TResponse>(HttpMethod method, string path, CancellationToken cancellationToken, PostData? data = null, IRequestParameters? requestParameters = null)
            where TResponse : class, IOpenSearchResponse, new()
        {
            var call = guard.Begin(method, path, data, inner.Settings);
            try
            {
                var response = await inner.RequestAsync<TResponse>(method, path, cancellationToken, data, requestParameters).ConfigureAwait(false);
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

    private DbCall Begin(HttpMethod method, string path, PostData? data, IConnectionConfigurationValues settings) =>
        SearchCall.Begin(capture, Store, method.ToString(), path, () => BodyOf(data, settings), treatAsRead);

    /// <summary>Logs a finished request. A reply with an error status is logged with that status as its error.</summary>
    private void Finish(DbCall call, IOpenSearchResponse response)
    {
        if (response.ApiCall?.HttpStatusCode is >= 400 and var status)
        {
            call.Fail(new HttpRequestException(status.ToString()), status.ToString());
            return;
        }

        call.Succeed();
    }
}
