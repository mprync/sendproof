using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.WebUtilities;
using Xunit;

namespace TestBench.AspNetCore.Tests;

public sealed class HostIntegrationTests
{
    [Theory]
    [InlineData("Development", false)]
    [InlineData("HostedDevelopment", true)]
    public async Task OAuthDiscoveryChallengesThroughTheHostWithoutAuthenticatingAnonymousRequests(string environment, bool hosted)
    {
        var pathBase = hosted ? "/tenant" : "";
        await using var host = await PreviewTestHost.StartAsync(environment, permitEnvironment: hosted, pathBase: hosted);
        var capabilities = await host.Client.GetFromJsonAsync<JsonElement>(pathBase + "/bench/_api/capabilities");
        Assert.Equal(JsonValueKind.Null, capabilities.GetProperty("identity").ValueKind);
        var provider = Assert.Single(capabilities.GetProperty("authProviders").EnumerateArray(),
            provider => provider.GetProperty("label").GetString() == "Workplace SSO");
        Assert.Equal("oauth", provider.GetProperty("kind").GetString());
        var challengeUrl = provider.GetProperty("url").GetString();
        Assert.Equal(pathBase + "/bench/_api/challenge?scheme=workplace", challengeUrl);

        using var challenge = await host.Client.GetAsync(challengeUrl);
        Assert.Equal(HttpStatusCode.Redirect, challenge.StatusCode);
        var destination = Assert.IsType<Uri>(challenge.Headers.Location);
        Assert.Equal(PreviewTestHost.OAuthAuthorizationEndpoint, destination.GetLeftPart(UriPartial.Path));
        var query = QueryHelpers.ParseQuery(destination.Query);
        Assert.Equal("test-client", query["client_id"].ToString());
        Assert.Equal("http://localhost" + pathBase + "/oauth/callback", query["redirect_uri"].ToString());
        Assert.False(string.IsNullOrWhiteSpace(query["state"].ToString()));
        Assert.Equal("S256", query["code_challenge_method"].ToString());
        Assert.StartsWith(".AspNetCore.Correlation.", Assert.Single(challenge.Headers.GetValues("Set-Cookie")));

        using var anonymous = await host.Client.GetAsync(pathBase + "/identity");
        Assert.Equal(HttpStatusCode.OK, anonymous.StatusCode);
        Assert.Null(anonymous.Headers.Location);
        Assert.False(anonymous.Headers.Contains("Set-Cookie"));
        var identity = await anonymous.Content.ReadFromJsonAsync<JsonElement>();
        Assert.False(identity.GetProperty("isAuthenticated").GetBoolean());
    }

    [Fact]
    public async Task MvcControllerAndActionAttributesOptIntoPreview()
    {
        await using var host = await PreviewTestHost.StartAsync(useControllers: true);
        var capabilities = await host.Client.GetFromJsonAsync<JsonElement>("/bench/_api/capabilities");
        var previews = capabilities.GetProperty("previewOperations").EnumerateArray().ToArray();
        foreach (var scope in new[] { "action", "controller" })
        {
            var path = $"/mvc/{scope}/";
            Assert.Contains(previews, operation => operation.GetProperty("method").GetString() == "GET" &&
                operation.GetProperty("path").GetString() == path + "{id}");

            using var request = new HttpRequestMessage(HttpMethod.Get, "/bench/_preview" + path + PreviewTestHost.PaymentId);
            request.Headers.Add("Prefer", "tx=rollback");
            using var response = await host.Client.SendAsync(request);
            response.EnsureSuccessStatusCode();
            var json = await response.Content.ReadFromJsonAsync<JsonElement>();
            Assert.True(json.GetProperty("rolledBack").GetBoolean());
            var body = json.GetProperty("body");
            Assert.Equal(PreviewTestHost.PaymentId, body.GetProperty("id").GetGuid());
            Assert.True(body.GetProperty("isPreview").GetBoolean());
        }

        Assert.DoesNotContain(previews, operation => operation.GetProperty("path").GetString() == "/mvc/action/unmarked");
        using var unmarked = new HttpRequestMessage(HttpMethod.Get, "/bench/_preview/mvc/action/unmarked");
        unmarked.Headers.Add("Prefer", "tx=rollback");
        using var refused = await host.Client.SendAsync(unmarked);
        Assert.Equal(HttpStatusCode.Conflict, refused.StatusCode);
    }
}
