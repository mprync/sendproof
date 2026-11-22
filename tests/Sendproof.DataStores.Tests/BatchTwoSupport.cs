using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Sendproof.AspNetCore;

namespace Sendproof.DataStores.Tests;

/// <summary>Where the shared spec and its recorded requests are, found from the test output like the other binding tests do.</summary>
internal static class Spec
{
    internal static string Directory { get; } = Find();

    private static string Find()
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            var candidate = Path.Combine(directory.FullName, "spec", "data-stores");
            if (System.IO.Directory.Exists(candidate)) return candidate;
        }

        throw new DirectoryNotFoundException("spec/data-stores was not found above the test output.");
    }

    /// <summary>The recordings of one store (<c>cosmosdb</c> or <c>firestore</c>), as the recordings README describes them.</summary>
    internal static JsonElement[] Recordings(string store)
    {
        using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(Directory, "recordings", store + ".json")));
        return [.. document.RootElement.GetProperty("recordings").EnumerateArray().Select(item => item.Clone())];
    }

    /// <summary>The names of a store's recordings, for a theory.</summary>
    internal static IEnumerable<object[]> RecordingNames(string store) => Recordings(store).Select((item, index) => new object[] { index, item.GetProperty("name").GetString()! });
}

/// <summary>
/// Lets a test hold a Preview open while another thread acts: the <c>/hold</c> route signals <see cref="Open"/> and then waits for
/// <see cref="Release"/>. Used for the writes that belong to no request.
/// </summary>
internal sealed class Gates
{
    internal TaskCompletionSource Open { get; private set; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

    internal TaskCompletionSource Release { get; private set; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

    internal void Reset()
    {
        Open = new(TaskCreationOptions.RunContinuationsAsynchronously);
        Release = new(TaskCreationOptions.RunContinuationsAsynchronously);
    }

    internal void Map(WebApplication app) => app.MapPost("/hold", async () =>
    {
        Open.TrySetResult();
        await Release.Task.WaitAsync(TimeSpan.FromSeconds(30));
        return Results.Ok();
    }).AllowAnonymous().WithSendproofPreview();

    /// <summary>Runs <paramref name="work"/> the way a background thread would: with the caller's execution context not flowed to it.</summary>
    internal static Task Detached(Func<Task> work)
    {
        using var _ = ExecutionContext.SuppressFlow();
        return Task.Run(work);
    }
}
