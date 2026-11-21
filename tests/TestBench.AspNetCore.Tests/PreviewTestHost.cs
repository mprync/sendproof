using System.Net.Http.Json;
using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.DataProtection.KeyManagement;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace TestBench.AspNetCore.Tests;

internal sealed class PreviewTestHost(WebApplication app, HttpClient client, PreviewState state) : IAsyncDisposable
{
    internal static readonly Guid PaymentId = new("e1e605e1-42de-4c70-9eb1-275d5055bdee");
    internal const string OAuthAuthorizationEndpoint = "https://sso.example.test/oauth/authorize";
    internal HttpClient Client => client;
    internal PreviewState State => state;

    internal static async Task<PreviewTestHost> StartAsync(string environment = "Development", bool mapBench = true,
        bool permitEnvironment = false, bool pathBase = false, bool requireBenchPolicy = false,
        bool providerAvailable = true, bool useControllers = false, TimeProvider? clock = null, string? benchSubject = null)
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
        builder.Services.AddAuthentication("test")
            .AddCookie("test", "Host sign in", options => options.LoginPath = "/account/signin")
            .AddOAuth("workplace", "Workplace SSO", options =>
            {
                options.SignInScheme = "test";
                options.ClientId = "test-client";
                options.ClientSecret = "unused-placeholder";
                options.AuthorizationEndpoint = OAuthAuthorizationEndpoint;
                options.TokenEndpoint = "https://sso.example.test/oauth/token";
                options.CallbackPath = "/oauth/callback";
                options.UsePkce = true;
                options.BackchannelHttpHandler = new NoNetworkHandler();
            });
        builder.Services.AddAuthorization(options => options.AddPolicy("Workbench", policy =>
        {
            policy.RequireAuthenticatedUser();
            if (benchSubject is not null)
            {
                policy.RequireClaim(ClaimTypes.NameIdentifier, benchSubject);
            }
        }));
        builder.Services.AddResponseCompression();
        builder.Services.AddOutputCache(options => options.AddBasePolicy(policy => policy.Cache()));
        var bench = builder.Services.AddTestBench().WithApiName("Test API").WithOpenApiUrl("/docs/current.json")
            .WithOpenApiDocument("Archive", "/docs/archive.json").WithAuthProvider("Password API", "cookie", "/session");
        if (permitEnvironment)
        {
            bench.InEnvironments(environment);
        }

        if (requireBenchPolicy)
        {
            bench.RequireAuthorization("Workbench");
        }

        var state = new PreviewState { ProviderAvailable = providerAvailable };
        builder.Services.AddSingleton(state);
        if (clock is not null)
        {
            builder.Services.AddSingleton(clock);
        }
        builder.Services.AddScoped<PreviewScope>();
        builder.Services.AddScoped<IPreviewProvider, TestPreviewProvider>();

        if (useControllers)
        {
            builder.Services.AddControllers().AddApplicationPart(typeof(PreviewProbeController).Assembly);
        }

        var app = builder.Build();
        if (pathBase)
        {
            app.UsePathBase("/tenant");
            app.UseRouting();
            app.UseAuthentication();
            app.UseAuthorization();
        }

        app.UseResponseCompression();
        app.UseOutputCache();
        MapEndpoints(app);
        if (useControllers)
        {
            app.MapControllers();
        }

        if (mapBench)
        {
            app.MapTestBench();
        }

        await app.StartAsync();
        app.GetTestServer().PreserveExecutionContext = true;
        var client = app.GetTestClient();
        client.Timeout = TimeSpan.FromSeconds(10);
        state.NestedClient = client;
        return new PreviewTestHost(app, client, state);
    }

    internal async Task<string> SignInAsync(string basePath = "", string subject = "robin")
    {
        using var result = await client.PostAsync($"{basePath}/session?subject={Uri.EscapeDataString(subject)}", null);
        result.EnsureSuccessStatusCode();
        return result.Headers.GetValues("Set-Cookie").Single().Split(';', 2)[0];
    }

    internal static HttpRequestMessage PaymentRequest(string path, string? cookie = null, string? preference = "tx=rollback")
    {
        var request = new HttpRequestMessage(HttpMethod.Post, $"{path}/payments/{PaymentId}?tag=verified")
        {
            Content = JsonContent.Create(new PaymentInput(25))
        };
        if (cookie is not null)
        {
            request.Headers.Add("Cookie", cookie);
        }

        if (preference is not null)
        {
            request.Headers.Add("Prefer", preference);
        }

        request.Headers.AcceptEncoding.ParseAdd("gzip");
        return request;
    }

    public async ValueTask DisposeAsync()
    {
        client.Dispose();
        await app.DisposeAsync();
    }

    private static void MapEndpoints(WebApplication app)
    {
        app.MapGet("/identity", (HttpContext context) => new { isAuthenticated = context.User.Identity?.IsAuthenticated == true })
            .AllowAnonymous();

        app.MapPost("/session", async (HttpContext context, string? subject) =>
        {
            const string roleType = "treasury-role";
            var identity = new ClaimsIdentity(
                [new Claim(ClaimTypes.Name, "Robin"), new Claim(ClaimTypes.Role, "Ignored"),
                    new Claim(ClaimTypes.NameIdentifier, subject ?? "robin"),
                    new Claim(roleType, "Approver"), new Claim(roleType, "Viewer")],
                "test", ClaimTypes.Name, roleType);
            await context.SignInAsync("test", new ClaimsPrincipal(identity));
            return Results.NoContent();
        });

        app.MapPost("/payments/{id:guid}", async (Guid id, string tag, PaymentInput input,
            HttpContext context, TestBenchPreview preview, PreviewState state) =>
        {
            state.ExecutionCount++;
            state.CurrentAmount = input.Amount;
            if (!preview.TryRecordEffect("email", "Receipt"))
            {
                state.RealDispatches++;
            }

            preview.TryRecordLog("information", "Saved payment");
            context.Response.OnCompleted(() =>
            {
                preview.TryRecordLog("information", "Finished response");
                return Task.CompletedTask;
            });
            context.Response.Headers.SetCookie = "live-only=1";
            context.Response.Headers.KeepAlive = "timeout=5";
            context.Response.OnStarting(() =>
            {
                context.Response.Headers["X-Started"] = "buffered";
                return Task.CompletedTask;
            });
            context.Response.StatusCode = 201;
            context.Response.ContentType = "application/json; charset=utf-8";
            await context.Response.StartAsync();
            await JsonSerializer.SerializeAsync(context.Response.Body, new { id, tag, input.Amount, actor = context.User.Identity!.Name },
                new JsonSerializerOptions(JsonSerializerDefaults.Web));
        }).RequireAuthorization().WithTestBenchPreview();

        app.MapPost("/capture/{mode}", async (string mode, TestBenchPreview preview, ILoggerFactory loggerFactory, PreviewState state) =>
        {
            var logger = loggerFactory.CreateLogger("TrackA.Scope");
            logger.LogDebug("Below configured host minimum");
            logger.LogWarning(new EventId(42, "Scope"), new InvalidOperationException("Structured error"),
                "Request {Mode} processed {Total}", mode, 17);
            var logCaptured = preview.TryRecordLog("Information", $"manual-{mode}");

            if (mode == "limits")
            {
                logger.LogWarning("Long property {Value}", new string('x', 8192));
                var fields = Enumerable.Range(0, 40).Select(index => new KeyValuePair<string, object?>($"Field{index}", index)).ToArray();
                logger.Log(LogLevel.Warning, new EventId(43, "ManyFields"), fields, null, static (_, _) => "Many fields");
                for (var index = 0; index < 600; index++)
                {
                    preview.TryRecordLog("Information", "repeat");
                }

                preview.TryRecordEffect("custom", "Large data", new { value = new string('x', 20000) });
                for (var index = 0; index < 110; index++)
                {
                    if (!preview.TryRecordEffect("custom", "Limit"))
                    {
                        state.RealDispatches++;
                    }
                }
            }

            if (mode == "effects")
            {
                preview.TryRecordEmail("Receipt", "sender@example.test", ["recipient@example.test"], ["cc@example.test"],
                    "Payment created", "Text body", "<p>HTML body</p>");
                preview.TryRecordHttp("Notify", "POST", "https://example.test/payments", 202, new { amount = 17 });
                preview.TryRecordJob("Schedule", "SettlePayment", new { amount = 17 }, "payments", DateTimeOffset.UnixEpoch);
                preview.TryRecordMessage("Publish", "payment.created", new { amount = 17 }, "payment-id");
            }

            if (mode == "nested")
            {
                using var child = await state.NestedClient!.PostAsync("/capture/child", null);
                child.EnsureSuccessStatusCode();
            }

            if (mode == "hold")
            {
                var release = state.ReleaseCapture!;
                state.CaptureStarted!.TrySetResult();
                await release.Task.WaitAsync(TimeSpan.FromSeconds(5));
                state.LateLog = Task.Run(async () =>
                {
                    await state.ReleaseLateLog!.Task.WaitAsync(TimeSpan.FromSeconds(5));
                    logger.LogWarning("Detached warning");
                    return preview.TryRecordLog("Information", "Detached manual log");
                });
            }

            return Results.Json(new { preview.IsActive, logCaptured });
        }).AllowAnonymous().WithTestBenchPreview();

        app.MapGet("/measurement", (TestBenchPreview preview) => Results.Json(new { isPreview = preview.IsActive }))
            .AllowAnonymous().CacheOutput().WithTestBenchPreview();
        app.MapPost("/unsupported", (PreviewState state) => state.ExecutionCount++).AllowAnonymous();
        app.MapFallback((HttpContext context) =>
        {
            context.RequestServices.GetRequiredService<PreviewState>().ExecutionCount++;
            return Results.NotFound().ExecuteAsync(context);
        });
    }

    public sealed record PaymentInput(int Amount);

    private sealed class NoNetworkHandler : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
            throw new InvalidOperationException("The OAuth test host must never make an outbound request.");
    }
}

internal sealed class PreviewState
{
    internal int CurrentAmount { get; set; }
    internal int ExecutionCount { get; set; }
    internal int RealDispatches { get; set; }
    internal bool ProviderAvailable { get; init; }
    internal TaskCompletionSource? RollbackStarted { get; set; }
    internal TaskCompletionSource? ReleaseRollback { get; set; }
    internal HttpClient? NestedClient { get; set; }
    internal TaskCompletionSource? CaptureStarted { get; set; }
    internal TaskCompletionSource? ReleaseCapture { get; set; }
    internal TaskCompletionSource? ReleaseLateLog { get; set; }
    internal Task<bool>? LateLog { get; set; }
}

internal sealed class PreviewScope : IDisposable
{
    internal bool IsDisposed { get; private set; }
    public void Dispose() => IsDisposed = true;
}

internal sealed class TestPreviewProvider(PreviewState state, PreviewScope scope) : IPreviewProvider
{
    public bool IsAvailable => state.ProviderAvailable;
    public string Database => "Test database";

    public ValueTask<IPreviewSession> BeginAsync(HttpContext context, CancellationToken cancellationToken) =>
        ValueTask.FromResult<IPreviewSession>(new Session(state, scope, state.CurrentAmount));

    private sealed class Session(PreviewState state, PreviewScope scope, int originalAmount) : IPreviewSession
    {
        public IReadOnlyList<PreviewChange> Changes { get; private set; } = [];

        public async ValueTask RollbackAsync(CancellationToken cancellationToken)
        {
            ObjectDisposedException.ThrowIf(scope.IsDisposed, scope);
            state.RollbackStarted?.TrySetResult();
            if (state.ReleaseRollback is { } release)
            {
                await release.Task.WaitAsync(TimeSpan.FromSeconds(5), cancellationToken);
            }

            if (state.CurrentAmount != originalAmount)
            {
                Changes = [new("update", "payments", PreviewTestHost.PaymentId, originalAmount, state.CurrentAmount)];
            }

            state.CurrentAmount = originalAmount;
        }

        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }
}
