using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

namespace Sendproof.AspNetCore;

internal static class WorkbenchAuthentication
{
    private const string ChallengePath = "/sendproof/_api/challenge?scheme=";

    internal static async Task<IReadOnlyList<AuthProvider>> DiscoverAsync(HttpContext context, SendproofOptions options)
    {
        var configured = options.AuthProviders.Select(provider => provider with
        {
            Url = LocalUrl.WithPathBase(context.Request, provider.Url!)
        });
        var providers = configured.ToList();
        if (!options.DiscoverAuthSchemes || context.RequestServices.GetService<IAuthenticationSchemeProvider>() is not { } schemes)
        {
            return providers;
        }

        foreach (var scheme in await schemes.GetAllSchemesAsync())
        {
            if (string.IsNullOrWhiteSpace(scheme.DisplayName))
            {
                continue;
            }

            var (kind, url) = Describe(context, scheme);
            if (!providers.Any(provider => provider.Label.Equals(scheme.DisplayName, StringComparison.OrdinalIgnoreCase) ||
                url is not null && string.Equals(provider.Url, url, StringComparison.Ordinal)))
            {
                providers.Add(new AuthProvider(scheme.DisplayName, kind, url));
            }
        }

        return providers;
    }

    internal static async Task<IResult> ChallengeAsync(HttpContext context, string scheme)
    {
        var options = context.RequestServices.GetRequiredService<SendproofOptions>();
        var schemes = context.RequestServices.GetService<IAuthenticationSchemeProvider>();
        if (!options.DiscoverAuthSchemes || schemes is null ||
            await schemes.GetSchemeAsync(scheme) is not { DisplayName: not null } discovered ||
            string.IsNullOrWhiteSpace(discovered.DisplayName) || !IsRemote(discovered.HandlerType))
        {
            return Results.NotFound();
        }

        context.Response.Headers.CacheControl = "no-store";
        return Results.Challenge(new AuthenticationProperties
        {
            RedirectUri = LocalUrl.WithPathBase(context.Request, "/sendproof/")
        }, [scheme]);
    }

    private static (string Kind, string? Url) Describe(HttpContext context, AuthenticationScheme scheme)
    {
        if (typeof(CookieAuthenticationHandler).IsAssignableFrom(scheme.HandlerType))
        {
            var cookieOptions = context.RequestServices.GetRequiredService<IOptionsMonitor<CookieAuthenticationOptions>>();
            var loginPath = cookieOptions.Get(scheme.Name).LoginPath;
            var url = loginPath.ToUriComponent();
            return ("login", LocalUrl.IsLocal(url) ? LocalUrl.WithPathBase(context.Request, url) : null);
        }

        if (IsRemote(scheme.HandlerType))
        {
            var kind = HasHandler(scheme.HandlerType, "Microsoft.AspNetCore.Authentication.OpenIdConnect.OpenIdConnectHandler") ? "oidc" : "oauth";
            return (kind, LocalUrl.WithPathBase(context.Request, ChallengePath + Uri.EscapeDataString(scheme.Name)));
        }

        var bearer = HasHandler(scheme.HandlerType, "Microsoft.AspNetCore.Authentication.JwtBearer.JwtBearerHandler") ||
            HasHandler(scheme.HandlerType, "Microsoft.AspNetCore.Authentication.BearerToken.BearerTokenHandler");
        return (bearer ? "bearer" : "custom", null);
    }

    private static bool IsRemote(Type handler)
    {
        for (var type = handler; type is not null; type = type.BaseType)
        {
            if (type.IsGenericType && type.GetGenericTypeDefinition() == typeof(RemoteAuthenticationHandler<>))
            {
                return true;
            }
        }

        return false;
    }

    private static bool HasHandler(Type handler, string fullName)
    {
        for (var type = handler; type is not null; type = type.BaseType)
        {
            if (string.Equals(type.FullName, fullName, StringComparison.Ordinal))
            {
                return true;
            }
        }

        return false;
    }
}
