using System.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace Sendproof.AspNetCore;

/// <summary>
/// One guarded command: checks it before it is sent, and records it as a <c>Db</c> entry when it finishes. Every
/// batch-two store hook uses this, so the order is the same everywhere: classify, refuse a write in a Preview (marking the
/// Preview blocked), send, then log the entry with its row count and elapsed time.
/// </summary>
internal readonly record struct DbCall(SendproofPreview? Recorder, DbEntry? Entry, long Started)
{
    /// <summary>
    /// Checks a command before it is sent. Throws <see cref="PreviewWriteBlockedException"/> for a write in a Preview. A
    /// session command, or any command outside a Preview and an observed Send, is allowed and not logged.
    /// </summary>
    /// <param name="capture">The host's capture slot.</param>
    /// <param name="store">The store id, such as <c>cassandra</c>.</param>
    /// <param name="classification">What the shared table says about the command.</param>
    /// <param name="describe">Builds the <c>Db</c> entry; only called when the command will be logged.</param>
    internal static DbCall Begin(CaptureContext capture, string store, Classification classification, Func<DbEntry> describe)
    {
        capture.Check(store, classification.Operation, classification.Kind);
        var recorder = classification.Kind == CommandKind.Session ? null : capture.Current;
        return recorder is null ? default : new DbCall(recorder, describe(), Stopwatch.GetTimestamp());
    }

    /// <summary>Logs the finished command, with the rows it matched, returned or wrote when the reply says so.</summary>
    internal void Succeed(int? rows = null)
    {
        if (Recorder is not null && Entry is not null)
        {
            Recorder.RecordDb(Entry with { RowsAffected = rows, ElapsedMs = Stopwatch.GetElapsedTime(Started).TotalMilliseconds });
        }
    }

    /// <summary>Logs a command the store answered with an error. A refused write was already logged as a blocked entry.</summary>
    internal void Fail(Exception error, string? code = null)
    {
        if (Recorder is not null && Entry is not null && error is not PreviewWriteBlockedException)
        {
            Recorder.RecordDb(Entry with { Error = code ?? error.GetType().Name, ElapsedMs = Stopwatch.GetElapsedTime(Started).TotalMilliseconds });
        }
    }
}

/// <summary>The shared check of the Elasticsearch and OpenSearch hooks: one request, by method and path.</summary>
internal static class SearchCall
{
    /// <summary>
    /// Checks a request before it is sent and prepares its <c>Db</c> entry (target index, and the body with every value
    /// replaced by <c>"?"</c>). <paramref name="body"/> is read only when the endpoint needs it or the request is logged. A
    /// <c>GET /</c> or <c>HEAD /</c> (the client's product check) is allowed and not logged.
    /// </summary>
    internal static DbCall Begin(CaptureContext capture, string system, string method, string path, Func<string?> body, IReadOnlySet<string>? treatAsRead)
    {
        var classification = ElasticsearchClassifier.Classify(method, path, body, treatAsRead);
        if (classification.Kind == CommandKind.Read && ElasticsearchClassifier.Segments(path).Length == 0)
        {
            classification = classification with { Kind = CommandKind.Session };
        }

        return DbCall.Begin(capture, system, classification, () => new DbEntry(system, classification.Operation)
        {
            Target = ElasticsearchClassifier.Target(path),
            Statement = ElasticsearchClassifier.Statement(body())
        });
    }
}

/// <summary>
/// Registration helpers for store hooks that decorate a client registered in the container. A guard that a later
/// registration can silently replace would let writes through, so each helper also adds a startup check that refuses to
/// start the host when the registered client is not guarded.
/// </summary>
internal static class GuardRegistration
{
    /// <summary>
    /// Replaces every registration of each type in <paramref name="decorate"/>, keyed or not and in place, with a factory that
    /// wraps the original in <paramref name="wrap"/>, so an earlier registration (reachable through <c>IEnumerable&lt;T&gt;</c>)
    /// and a keyed one are guarded too. Then adds a startup check (see <see cref="RequireCovered"/>) that stops the host when any
    /// registration of a type in <paramref name="clientTypes"/> is not one of these: a registration added after the <c>Add…</c>
    /// call, or a client registered by a class or base the guard can't decorate. Throws when none of <paramref name="decorate"/>
    /// is registered yet.
    /// </summary>
    /// <param name="services">The host's services.</param>
    /// <param name="decorate">The service types the guard replaces with guarded decorators.</param>
    /// <param name="clientTypes">Every type a registered client of this store could be resolved as.</param>
    /// <param name="wrap">Guards one resolved client of the given service type.</param>
    /// <param name="isGuarded">Whether an instance registered some other way already sends through this store's guard.</param>
    /// <param name="addMethod">The <c>Add…</c> method, for the messages.</param>
    /// <param name="advice">What to do about a client the guard can't decorate, for the startup message.</param>
    internal static void DecorateAll(IServiceCollection services, Type[] decorate, Type[] clientTypes, Func<Type, object, object> wrap,
        Func<object, bool> isGuarded, string addMethod, string advice)
    {
        var ours = new HashSet<ServiceDescriptor>(ReferenceEqualityComparer.Instance);
        for (var index = 0; index < services.Count; index++)
        {
            var original = services[index];
            if (!decorate.Contains(original.ServiceType))
            {
                continue;
            }

            var type = original.ServiceType;
            var lifetime = original.Lifetime == ServiceLifetime.Transient ? ServiceLifetime.Transient : ServiceLifetime.Singleton;
            var replacement = original.IsKeyedService
                ? ServiceDescriptor.DescribeKeyed(type, original.ServiceKey, (provider, key) => wrap(type, ResolveKeyed(provider, original, key)), lifetime)
                : ServiceDescriptor.Describe(type, provider => wrap(type, Resolve(provider, original)), lifetime);
            services[index] = replacement;
            ours.Add(replacement);
        }

        if (ours.Count == 0)
        {
            throw new InvalidOperationException(
                $"Register {string.Join(" or ", decorate.Select(type => type.Name))} before {addMethod}: it replaces that registration with a guarded one, so everything resolved from the container is covered.");
        }

        RequireCovered(services, ours, decorate, clientTypes, isGuarded, addMethod, advice);
    }

    /// <summary>
    /// Stops the host when a registration of any of <paramref name="clientTypes"/> (keyed or not, by the type itself or by a
    /// class that derives from it) is not one of <paramref name="ours"/> and is not an instance <paramref name="isGuarded"/>
    /// accepts: Preview would let its writes through.
    /// </summary>
    private static void RequireCovered(IServiceCollection services, IReadOnlySet<ServiceDescriptor> ours, Type[] decorated, Type[] clientTypes,
        Func<object, bool> isGuarded, string addMethod, string advice) =>
        Require(services, _ =>
        {
            foreach (var descriptor in services)
            {
                if (ours.Contains(descriptor) || !clientTypes.Any(type => type.IsAssignableFrom(descriptor.ServiceType)))
                {
                    continue;
                }

                var instance = descriptor.IsKeyedService ? descriptor.KeyedImplementationInstance : descriptor.ImplementationInstance;
                if (instance is not null && isGuarded(instance))
                {
                    continue;
                }

                var name = descriptor.IsKeyedService ? $"{descriptor.ServiceType.Name} (keyed \"{descriptor.ServiceKey}\")" : descriptor.ServiceType.Name;
                return decorated.Contains(descriptor.ServiceType)
                    ? $"{name} was registered again after {addMethod}, so that registration is not guarded and Preview would let its writes through. " +
                      $"Register {descriptor.ServiceType.Name} before {addMethod}."
                    : $"{name} is registered in the container, and {addMethod} can't guard it, so Preview would let its writes through. {advice}";
            }

            return null;
        });

    /// <summary>
    /// Adds a check that runs when the host starts, before it serves a request. <paramref name="problem"/> returns a
    /// sentence describing why the registered client is not guarded, or <see langword="null"/> when it is.
    /// </summary>
    internal static void Require(IServiceCollection services, Func<IServiceProvider, string?> problem) =>
        services.AddSingleton<IHostedService>(provider => new StartupCheck(provider, problem));

    private static object Resolve(IServiceProvider provider, ServiceDescriptor descriptor) =>
        descriptor.ImplementationInstance ??
        (descriptor.ImplementationFactory is { } factory
            ? factory(provider)
            : ActivatorUtilities.CreateInstance(provider, descriptor.ImplementationType!));

    private static object ResolveKeyed(IServiceProvider provider, ServiceDescriptor descriptor, object? key) =>
        descriptor.KeyedImplementationInstance ??
        (descriptor.KeyedImplementationFactory is { } factory
            ? factory(provider, key)
            : ActivatorUtilities.CreateInstance(provider, descriptor.KeyedImplementationType!));

    private sealed class StartupCheck(IServiceProvider provider, Func<IServiceProvider, string?> problem) : IHostedService
    {
        public Task StartAsync(CancellationToken cancellationToken) =>
            problem(provider) is { } message ? throw new InvalidOperationException(message) : Task.CompletedTask;

        public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
    }
}
