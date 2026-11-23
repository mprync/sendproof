using System.Reflection;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Hosting;
using Sendproof.AspNetCore;

namespace Sendproof.Journeys;

/// <summary>Registers journeys with Sendproof.</summary>
public static class SendproofJourneysExtensions
{
    /// <summary>Registers every journey class in an assembly.</summary>
    /// <param name="sendproof">The Sendproof builder.</param>
    /// <param name="assembly">The assembly to scan, such as <c>typeof(StoreApplication).Assembly</c>.</param>
    /// <param name="configure">Names the published document and maps document classes to collections.</param>
    public static SendproofBuilder AddJourneys(this SendproofBuilder sendproof, Assembly assembly, Action<JourneyOptions>? configure = null)
    {
        ArgumentNullException.ThrowIfNull(assembly);
        var registry = Registry(sendproof);
        registry.Journeys.AddRange(assembly.GetTypes().Where(type =>
            type is { IsAbstract: false, IsGenericTypeDefinition: false } && type.IsSubclassOf(typeof(Journey)) && type.GetConstructor(Type.EmptyTypes) is not null));
        configure?.Invoke(registry.Options);
        return sendproof;
    }

    /// <summary>Registers one journey class.</summary>
    public static SendproofBuilder AddJourney<TJourney>(this SendproofBuilder sendproof, Action<JourneyOptions>? configure = null)
        where TJourney : Journey, new()
    {
        var registry = Registry(sendproof);
        registry.Journeys.Add(typeof(TJourney));
        configure?.Invoke(registry.Options);
        return sendproof;
    }

    /// <summary>
    /// Serves a hand-written or exported Arazzo file (JSON or YAML), with its expectations: by default the file beside it
    /// named <c>{name}.expect.json</c>, when there is one.
    /// </summary>
    /// <param name="sendproof">The Sendproof builder.</param>
    /// <param name="file">The Arazzo file, relative to the content root, such as <c>journeys/store.arazzo.json</c>.</param>
    /// <param name="expectationsFile">The expectations file, relative to the content root, when it isn't beside it.</param>
    public static SendproofBuilder WithJourneys(this SendproofBuilder sendproof, string file, string? expectationsFile = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(file);
        Registry(sendproof).Files.Add(new JourneyFile(file, expectationsFile));
        return sendproof;
    }

    private static JourneyRegistry Registry(SendproofBuilder sendproof)
    {
        ArgumentNullException.ThrowIfNull(sendproof);
        var services = sendproof.Services;
        if (services.LastOrDefault(descriptor => descriptor.ServiceType == typeof(JourneyRegistry))?.ImplementationInstance is JourneyRegistry existing)
        {
            return existing;
        }

        var registry = new JourneyRegistry();
        services.AddSingleton(registry);
        services.TryAddSingleton<JourneyDocuments>();
        services.TryAddSingleton<JourneyDocumentFactory>();
        services.TryAddEnumerable(ServiceDescriptor.Singleton<IWorkbenchExtension, JourneyWorkbench>());
        services.TryAddEnumerable(ServiceDescriptor.Singleton<IHostedService, JourneyStartup>());
        return registry;
    }
}
