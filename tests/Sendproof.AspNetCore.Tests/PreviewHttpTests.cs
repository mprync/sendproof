using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Xunit;

namespace Sendproof.AspNetCore.Tests;

public sealed class PreviewHttpTests
{
    [Fact]
    public async Task PreviewUsesRealBindingAndAuthorizationAndWaitsForRollback()
    {
        await using var host = await PreviewTestHost.StartAsync();
        var cookie = await host.SignInAsync();
        host.State.RollbackStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        host.State.ReleaseRollback = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

        using var request = PreviewTestHost.PaymentRequest("/sendproof/_preview", cookie);
        request.Headers.Add("Origin", "http://localhost");
        var pending = host.Client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead);
        try
        {
            await host.State.RollbackStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.False(pending.IsCompleted);
            Assert.Equal(25, host.State.CurrentAmount);
        }
        finally
        {
            host.State.ReleaseRollback.TrySetResult();
        }

        using var response = await pending;
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("tx=rollback", Assert.Single(response.Headers.GetValues("Preference-Applied")));
        Assert.False(response.Headers.Contains("Set-Cookie"));
        var json = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(json.GetProperty("rolledBack").GetBoolean());
        Assert.Equal(201, json.GetProperty("status").GetInt32());
        Assert.Equal("buffered", json.GetProperty("headers").GetProperty("x-started").GetString());
        Assert.False(json.GetProperty("headers").TryGetProperty("set-cookie", out _));
        Assert.False(json.GetProperty("headers").TryGetProperty("keep-alive", out _), "Hop-by-hop headers stay out of the envelope.");
        Assert.Equal(PreviewTestHost.PaymentId, json.GetProperty("body").GetProperty("id").GetGuid());
        Assert.Equal("verified", json.GetProperty("body").GetProperty("tag").GetString());
        Assert.Equal("Robin", json.GetProperty("body").GetProperty("actor").GetString());
        Assert.Equal(25, Assert.Single(json.GetProperty("changes").EnumerateArray()).GetProperty("after").GetInt32());
        Assert.Equal("email", Assert.Single(json.GetProperty("effects").EnumerateArray()).GetProperty("kind").GetString());
        Assert.Equal(new[] { "Saved payment", "Finished response" }, json.GetProperty("logs").EnumerateArray()
            .Select(log => log.GetProperty("message").GetString()).ToArray());
        Assert.Equal(0, host.State.CurrentAmount);
        Assert.Equal(0, host.State.RealDispatches);
    }

    [Fact]
    public async Task DirectRollbackMalformedMissingPreferenceAndUnsupportedTargetsCannotExecute()
    {
        await using var host = await PreviewTestHost.StartAsync();
        var cookie = await host.SignInAsync();
        using var live = PreviewTestHost.PaymentRequest("", cookie, "respond-async, tx = \"rollback\"");
        using var liveResponse = await host.Client.SendAsync(live);
        Assert.Equal(HttpStatusCode.BadRequest, liveResponse.StatusCode);

        using var missing = PreviewTestHost.PaymentRequest("/sendproof/_preview", cookie, null);
        using var missingResponse = await host.Client.SendAsync(missing);
        Assert.Equal(HttpStatusCode.BadRequest, missingResponse.StatusCode);

        foreach (var path in new[] { "/unsupported", "/absent" })
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, "/sendproof/_preview" + path);
            request.Headers.Add("Prefer", "tx=rollback");
            using var result = await host.Client.SendAsync(request);
            Assert.Equal(HttpStatusCode.Conflict, result.StatusCode);
        }

        Assert.Equal(0, host.State.ExecutionCount);
    }

    [Fact]
    public async Task UnmappedWorkbenchCannotExecutePreview()
    {
        await using var host = await PreviewTestHost.StartAsync("Development", mapBench: false);
        using var request = PreviewTestHost.PaymentRequest("/sendproof/_preview", await host.SignInAsync());
        using var result = await host.Client.SendAsync(request);
        Assert.Equal(HttpStatusCode.NotFound, result.StatusCode);
        Assert.Equal(0, host.State.ExecutionCount);
    }

    [Fact]
    public async Task ExplicitEnvironmentRetainsCustomDiscoveryConfiguration()
    {
        await using var host = await PreviewTestHost.StartAsync("Staging", permitEnvironment: true, pathBase: true);
        var cookie = await host.SignInAsync("/tenant");
        using var capsRequest = new HttpRequestMessage(HttpMethod.Get, "/tenant/sendproof/_api/capabilities");
        capsRequest.Headers.Add("Cookie", cookie);
        using var capabilities = await host.Client.SendAsync(capsRequest);
        capabilities.EnsureSuccessStatusCode();
        var json = await capabilities.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(1, json.GetProperty("protocolVersion").GetInt32());
        Assert.Equal("/tenant/docs/current.json", json.GetProperty("openApiUrl").GetString());
        Assert.Equal("Test API", json.GetProperty("apiName").GetString());
        Assert.Equal("Staging", json.GetProperty("environment").GetString());
        Assert.Equal("Test database", json.GetProperty("database").GetString());
        Assert.Equal("Robin", json.GetProperty("identity").GetProperty("name").GetString());
        Assert.Equal("Approver", json.GetProperty("identity").GetProperty("role").GetString());
        Assert.Contains(json.GetProperty("documents").EnumerateArray(), document =>
            document.GetProperty("url").GetString() == "/tenant/docs/archive.json");
        Assert.Contains(json.GetProperty("previewOperations").EnumerateArray(), operation =>
            operation.GetProperty("method").GetString() == "POST" && operation.GetProperty("path").GetString() == "/payments/{id}");
        Assert.Contains(json.GetProperty("authProviders").EnumerateArray(), provider =>
            provider.GetProperty("kind").GetString() == "login" && provider.GetProperty("url").GetString() == "/tenant/account/signin");
        Assert.Contains(json.GetProperty("authProviders").EnumerateArray(), provider =>
            provider.GetProperty("kind").GetString() == "cookie" && provider.GetProperty("url").GetString() == "/tenant/session");

        using var request = PreviewTestHost.PaymentRequest("/tenant/sendproof/_preview", cookie);
        using var result = await host.Client.SendAsync(request);
        Assert.Equal(HttpStatusCode.OK, result.StatusCode);
        Assert.Equal(0, host.State.CurrentAmount);
    }

    [Fact]
    public async Task UnavailableProviderIsNotAdvertisedAndCannotStartPreview()
    {
        await using var host = await PreviewTestHost.StartAsync(providerAvailable: false);
        var capabilities = await host.Client.GetFromJsonAsync<JsonElement>("/sendproof/_api/capabilities");
        Assert.Equal(JsonValueKind.Null, capabilities.GetProperty("database").ValueKind);
        Assert.Empty(capabilities.GetProperty("previewOperations").EnumerateArray());

        using var request = PreviewTestHost.PaymentRequest("/sendproof/_preview", await host.SignInAsync());
        using var result = await host.Client.SendAsync(request);
        Assert.Equal(HttpStatusCode.ServiceUnavailable, result.StatusCode);
        Assert.Equal(0, host.State.ExecutionCount);
    }

    [Fact]
    public async Task PreviewBypassesHostOutputCaching()
    {
        await using var host = await PreviewTestHost.StartAsync();
        Assert.False((await host.Client.GetFromJsonAsync<JsonElement>("/measurement")).GetProperty("isPreview").GetBoolean());

        using var request = new HttpRequestMessage(HttpMethod.Get, "/sendproof/_preview/measurement");
        request.Headers.Add("Prefer", "tx=rollback");
        using var result = await host.Client.SendAsync(request);
        var preview = await result.Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(preview.GetProperty("rolledBack").GetBoolean());
        Assert.True(preview.GetProperty("body").GetProperty("isPreview").GetBoolean());
        Assert.False((await host.Client.GetFromJsonAsync<JsonElement>("/measurement")).GetProperty("isPreview").GetBoolean());
    }

    [Fact]
    public async Task NamedWorkbenchPolicyAlsoProtectsAnonymousPreviewEndpoints()
    {
        await using var host = await PreviewTestHost.StartAsync(requireBenchPolicy: true);
        using var request = new HttpRequestMessage(HttpMethod.Get, "/sendproof/_preview/measurement");
        request.Headers.Add("Prefer", "tx=rollback");
        using var result = await host.Client.SendAsync(request);
        Assert.Equal(HttpStatusCode.Unauthorized, result.StatusCode);

        using var capabilities = await host.Client.GetAsync("/sendproof/_api/capabilities");
        Assert.False(capabilities.IsSuccessStatusCode);
    }
}
