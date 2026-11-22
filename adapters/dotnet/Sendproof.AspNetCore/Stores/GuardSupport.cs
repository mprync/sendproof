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

/// <summary>
/// Registration helpers for store hooks that decorate a client registered in the container. A guard that a later
/// registration can silently replace would let writes through, so each helper also adds a startup check that refuses to
/// start the host when the registered client is not guarded.
/// </summary>
internal static class GuardRegistration
{
    /// <summary>
    /// Replaces the last registration of <paramref name="serviceType"/> with a factory that wraps the original in
    /// <paramref name="wrap"/>, and returns the new descriptor. A host that registers the service again after the
    /// <c>Add…</c> call fails at startup (see <see cref="RequireGuarded"/>), because that registration would win.
    /// </summary>
    internal static ServiceDescriptor Decorate(IServiceCollection services, Type serviceType, Func<object, object> wrap, string addMethod)
    {
        var original = services.LastOrDefault(descriptor => descriptor.ServiceType == serviceType && !descriptor.IsKeyedService) ??
            throw new InvalidOperationException(
                $"Register {serviceType.Name} before {addMethod}: it replaces that registration with a guarded one, so everything resolved from the container is covered.");
        services.Remove(original);
        var decorated = ServiceDescriptor.Describe(serviceType, provider => wrap(Resolve(provider, original)),
            original.Lifetime == ServiceLifetime.Transient ? ServiceLifetime.Transient : ServiceLifetime.Singleton);
        services.Add(decorated);
        RequireGuarded(services, serviceType, decorated, addMethod);
        return decorated;
    }

    /// <summary>
    /// Refuses to start the host when the registration that wins for <paramref name="serviceType"/> is not
    /// <paramref name="ours"/>: something registered it again after the guard was added.
    /// </summary>
    internal static void RequireGuarded(IServiceCollection services, Type serviceType, ServiceDescriptor ours, string addMethod) =>
        Require(services, _ => services.LastOrDefault(descriptor => descriptor.ServiceType == serviceType && !descriptor.IsKeyedService) is { } last && ReferenceEquals(last, ours)
            ? null
            : $"{serviceType.Name} was registered again after {addMethod}, so the registration that wins is not guarded and Preview would let its writes through. " +
              $"Register {serviceType.Name} before {addMethod}.");

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

    private sealed class StartupCheck(IServiceProvider provider, Func<IServiceProvider, string?> problem) : IHostedService
    {
        public Task StartAsync(CancellationToken cancellationToken) =>
            problem(provider) is { } message ? throw new InvalidOperationException(message) : Task.CompletedTask;

        public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
    }
}
