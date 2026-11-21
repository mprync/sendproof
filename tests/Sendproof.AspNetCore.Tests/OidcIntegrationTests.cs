using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.OpenIdConnect;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.DataProtection.KeyManagement;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.TestHost;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.IdentityModel.Protocols.OpenIdConnect;
using Microsoft.IdentityModel.Tokens;
using Xunit;

namespace Sendproof.AspNetCore.Tests;

/// <summary>Exercises the workbench's handoff to the host's real OIDC, cookie and authorization middleware.</summary>
public sealed class OidcIntegrationTests
{
    private const string ApiOrigin = "https://api.workbench.test";
    private const string CallbackPath = "/signin-oidc";
    private const string SessionCookie = "Workbench.Session";
    private const string ProtectedPath = "/payments/approvals";

    [Theory]
    [InlineData("Development", "", "Approver", HttpStatusCode.OK)]
    [InlineData("Development", "", "Viewer", HttpStatusCode.Forbidden)]
    [InlineData("HostedDevelopment", "/tenant", "Approver", HttpStatusCode.OK)]
    [InlineData("HostedDevelopment", "/tenant", "Viewer", HttpStatusCode.Forbidden)]
    public async Task OidcCallbackCreatesAHostSessionSubjectToApiPolicy(
        string environment, string pathBase, string role, HttpStatusCode policyStatus)
    {
        using var provider = new OidcTestIdentityProvider(ApiOrigin + pathBase + CallbackPath) { Role = role };
        using var identityClient = new HttpClient(provider, disposeHandler: false);
        await using var app = CreateHost(environment, pathBase, identityClient);
        await app.StartAsync();
        using var browser = CreateBrowser(app);

        using var beforeSignIn = await browser.GetAsync(pathBase + ProtectedPath);
        Assert.Equal(HttpStatusCode.Unauthorized, beforeSignIn.StatusCode);

        var callback = await BeginSignInAsync(browser, identityClient, pathBase);
        using var signedIn = await browser.GetAsync(callback);
        Assert.Equal(1, provider.TokenRequests);
        Assert.Equal(HttpStatusCode.Redirect, signedIn.StatusCode);
        Assert.Equal(pathBase + "/sendproof/", signedIn.Headers.Location?.OriginalString);
        Assert.Contains(signedIn.Headers.GetValues("Set-Cookie"), IsSessionCookie);

        using var workbench = await browser.GetAsync(signedIn.Headers.Location);
        Assert.Equal(HttpStatusCode.OK, workbench.StatusCode);
        var capabilities = await browser.GetFromJsonAsync<JsonElement>(pathBase + "/sendproof/_api/capabilities");
        Assert.Equal(environment, capabilities.GetProperty("environment").GetString());
        var identity = capabilities.GetProperty("identity");
        Assert.Equal(OidcTestIdentityProvider.UserName, identity.GetProperty("name").GetString());
        Assert.Equal(role, identity.GetProperty("role").GetString());

        using var operation = await browser.GetAsync(pathBase + ProtectedPath);
        Assert.Equal(policyStatus, operation.StatusCode);
        if (policyStatus == HttpStatusCode.OK)
        {
            var result = await operation.Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal(OidcTestIdentityProvider.Subject, result.GetProperty("subject").GetString());
        }
    }

    [Theory]
    [InlineData("Development", "", CallbackFault.InvalidState)]
    [InlineData("Development", "", CallbackFault.MissingCorrelationCookie)]
    [InlineData("Development", "", CallbackFault.InvalidNonce)]
    [InlineData("Development", "", CallbackFault.InvalidAudience)]
    [InlineData("HostedDevelopment", "/tenant", CallbackFault.InvalidState)]
    [InlineData("HostedDevelopment", "/tenant", CallbackFault.MissingCorrelationCookie)]
    [InlineData("HostedDevelopment", "/tenant", CallbackFault.InvalidNonce)]
    [InlineData("HostedDevelopment", "/tenant", CallbackFault.InvalidAudience)]
    public async Task RejectedOidcCallbacksLeaveTheBrowserAnonymous(string environment, string pathBase, CallbackFault fault)
    {
        using var provider = new OidcTestIdentityProvider(ApiOrigin + pathBase + CallbackPath)
        {
            TokenNonce = fault == CallbackFault.InvalidNonce ? "unexpected-nonce" : null,
            TokenAudience = fault == CallbackFault.InvalidAudience ? "another-client" : null
        };
        using var identityClient = new HttpClient(provider, disposeHandler: false);
        Exception? reportedFailure = null;
        await using var app = CreateHost(environment, pathBase, identityClient, failure => reportedFailure = failure);
        await app.StartAsync();
        using var browser = CreateBrowser(app);

        var callback = await BeginSignInAsync(browser, identityClient, pathBase);
        if (fault == CallbackFault.InvalidState)
        {
            callback = new Uri(QueryHelpers.AddQueryString(callback.GetLeftPart(UriPartial.Path), new Dictionary<string, string?>
            {
                ["code"] = QueryHelpers.ParseQuery(callback.Query)["code"].ToString(),
                ["state"] = "invalid-state"
            }));
        }

        using var separateBrowser = fault == CallbackFault.MissingCorrelationCookie ? CreateBrowser(app) : null;
        var callbackBrowser = separateBrowser ?? browser;
        using var refused = await callbackBrowser.GetAsync(callback);
        Assert.Equal(HttpStatusCode.BadRequest, refused.StatusCode);
        Assert.Null(refused.Headers.Location);
        if (refused.Headers.TryGetValues("Set-Cookie", out var cookies))
        {
            Assert.DoesNotContain(cookies, IsSessionCookie);
        }

        Assert.NotNull(reportedFailure);
        Assert.Equal(fault is CallbackFault.InvalidNonce or CallbackFault.InvalidAudience ? 1 : 0, provider.TokenRequests);
        if (fault == CallbackFault.InvalidNonce)
        {
            Assert.IsType<OpenIdConnectProtocolInvalidNonceException>(reportedFailure);
        }
        else if (fault == CallbackFault.InvalidAudience)
        {
            Assert.IsType<SecurityTokenInvalidAudienceException>(reportedFailure);
        }

        var capabilities = await callbackBrowser.GetFromJsonAsync<JsonElement>(pathBase + "/sendproof/_api/capabilities");
        Assert.Equal(JsonValueKind.Null, capabilities.GetProperty("identity").ValueKind);
        using var operation = await callbackBrowser.GetAsync(pathBase + ProtectedPath);
        Assert.Equal(HttpStatusCode.Unauthorized, operation.StatusCode);
    }

    private static async Task<Uri> BeginSignInAsync(HttpClient browser, HttpClient identityClient, string pathBase)
    {
        var capabilities = await browser.GetFromJsonAsync<JsonElement>(pathBase + "/sendproof/_api/capabilities");
        Assert.Equal(JsonValueKind.Null, capabilities.GetProperty("identity").ValueKind);
        var provider = Assert.Single(capabilities.GetProperty("authProviders").EnumerateArray());
        Assert.Equal("Workplace SSO", provider.GetProperty("label").GetString());
        Assert.Equal("oidc", provider.GetProperty("kind").GetString());
        var challengeUrl = provider.GetProperty("url").GetString();
        Assert.Equal(pathBase + "/sendproof/_api/challenge?scheme=workplace", challengeUrl);

        using var challenge = await browser.GetAsync(challengeUrl);
        Assert.Equal(HttpStatusCode.Redirect, challenge.StatusCode);
        var authorizationUrl = Assert.IsType<Uri>(challenge.Headers.Location);
        Assert.Equal(OidcTestIdentityProvider.AuthorizationEndpoint, authorizationUrl.GetLeftPart(UriPartial.Path));
        using var authorization = await identityClient.GetAsync(authorizationUrl);
        Assert.True(authorization.StatusCode == HttpStatusCode.Redirect, await authorization.Content.ReadAsStringAsync());
        var callback = Assert.IsType<Uri>(authorization.Headers.Location);
        Assert.Equal(ApiOrigin + pathBase + CallbackPath, callback.GetLeftPart(UriPartial.Path));
        return callback;
    }

    private static WebApplication CreateHost(string environment, string pathBase, HttpClient identityClient,
        Action<Exception?>? reportFailure = null)
    {
        var builder = WebApplication.CreateBuilder(new WebApplicationOptions
        {
            Args = ["--hostBuilder:reloadConfigOnChange=false"],
            EnvironmentName = environment
        });
        builder.WebHost.UseTestServer();
        builder.Services.AddDataProtection();
        builder.Services.AddOptions<KeyManagementOptions>().Configure(options => options.XmlRepository = new InMemoryKeyRepository());
        builder.Logging.SetMinimumLevel(LogLevel.Warning);
        builder.Services.AddAuthentication("session")
            .AddCookie("session", options =>
            {
                options.Cookie.Name = SessionCookie;
                options.Cookie.SecurePolicy = CookieSecurePolicy.Always;
            })
            .AddOpenIdConnect("workplace", "Workplace SSO", options =>
            {
                options.SignInScheme = "session";
                options.Authority = OidcTestIdentityProvider.Authority;
                options.ClientId = OidcTestIdentityProvider.ClientId;
                options.CallbackPath = CallbackPath;
                options.ResponseType = OpenIdConnectResponseType.Code;
                options.ResponseMode = OpenIdConnectResponseMode.Query;
                options.UsePkce = true;
                options.Backchannel = identityClient;
                options.MapInboundClaims = false;
                options.TokenValidationParameters.NameClaimType = "name";
                options.TokenValidationParameters.RoleClaimType = "role";
                options.Events.OnRemoteFailure = context =>
                {
                    reportFailure?.Invoke(context.Failure);
                    context.Response.StatusCode = StatusCodes.Status400BadRequest;
                    context.HandleResponse();
                    return Task.CompletedTask;
                };
            });
        builder.Services.AddAuthorizationBuilder().AddPolicy("ApprovePayments", policy => policy.RequireRole("Approver"));
        var bench = builder.Services.AddSendproof();
        if (environment == "HostedDevelopment")
        {
            bench.InEnvironments("Development", "HostedDevelopment");
        }

        var app = builder.Build();
        if (pathBase.Length > 0)
        {
            app.UsePathBase(pathBase);
        }

        app.UseRouting();
        app.UseAuthentication();
        app.UseAuthorization();
        app.MapGet(ProtectedPath, (HttpContext context) => TypedResults.Ok(new { subject = context.User.FindFirst("sub")?.Value }))
            .RequireAuthorization("ApprovePayments");
        app.MapSendproof();
        return app;
    }

    private static HttpClient CreateBrowser(WebApplication app) => new(new CookieHandler(app.GetTestServer().CreateHandler()))
    {
        BaseAddress = new Uri(ApiOrigin),
        Timeout = TimeSpan.FromSeconds(10)
    };

    private static bool IsSessionCookie(string value) => value.StartsWith(SessionCookie + "=", StringComparison.Ordinal);

    public enum CallbackFault { InvalidState, MissingCorrelationCookie, InvalidNonce, InvalidAudience }

    // TestServer leaves redirects and cookie persistence to the caller.
    private sealed class CookieHandler(HttpMessageHandler innerHandler) : DelegatingHandler(innerHandler)
    {
        private readonly CookieContainer _cookies = new();

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var uri = request.RequestUri!;
            var cookieHeader = _cookies.GetCookieHeader(uri);
            if (cookieHeader.Length > 0)
            {
                request.Headers.Add("Cookie", cookieHeader);
            }

            var response = await base.SendAsync(request, cancellationToken);
            if (response.Headers.TryGetValues("Set-Cookie", out var values))
            {
                foreach (var cookie in values)
                {
                    _cookies.SetCookies(uri, cookie);
                }
            }

            return response;
        }
    }
}
