using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Sendproof.AspNetCore;

namespace Sendproof.Journeys;

/// <summary>
/// Builds and checks the journey documents as the host starts, before any hosted service (the web server included)
/// starts, so the first request already finds them. In Development a problem stops startup with the full list;
/// elsewhere each problem is logged and the journey or file it belongs to is skipped.
/// </summary>
internal sealed class JourneyStartup(JourneyDocumentFactory factory, JourneyDocuments documents, SendproofOptions sendproof,
    IHostEnvironment environment, ILogger<JourneyStartup> logger) : IHostedLifecycleService
{
    public Task StartingAsync(CancellationToken cancellationToken)
    {
        if (!sendproof.Enabled(environment))
        {
            return Task.CompletedTask;
        }

        var (built, problems) = factory.Build();
        if (problems.Count > 0)
        {
            if (environment.IsDevelopment())
            {
                throw new JourneyValidationException(problems);
            }

            foreach (var problem in problems)
            {
                logger.LogWarning("Skipped a journey: {Problem}", problem);
            }
        }

        documents.Publish(built);
        return Task.CompletedTask;
    }

    public Task StartAsync(CancellationToken cancellationToken) => Task.CompletedTask;
    public Task StartedAsync(CancellationToken cancellationToken) => Task.CompletedTask;
    public Task StoppingAsync(CancellationToken cancellationToken) => Task.CompletedTask;
    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
    public Task StoppedAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}
