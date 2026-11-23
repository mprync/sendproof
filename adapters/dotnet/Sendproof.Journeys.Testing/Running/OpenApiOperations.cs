using Microsoft.OpenApi;

namespace Sendproof.Journeys.Testing;

/// <summary>The method and path template of each operation in the OpenAPI document, read with Microsoft.OpenApi.</summary>
internal static class OpenApiOperations
{
    internal static async Task<Dictionary<string, (HttpMethod Method, string Path)>> LoadAsync(HttpClient client, string url, CancellationToken cancellationToken)
    {
        var result = OpenApiDocument.Parse(await client.GetStringAsync(url, cancellationToken), "json");
        var operations = new Dictionary<string, (HttpMethod, string)>(StringComparer.Ordinal);
        foreach (var (path, item) in result.Document?.Paths ?? [])
        {
            foreach (var (method, operation) in item.Operations ?? [])
            {
                if (operation.OperationId is { } id)
                {
                    operations.TryAdd(id, (method, path));
                }
            }
        }

        return operations;
    }
}
