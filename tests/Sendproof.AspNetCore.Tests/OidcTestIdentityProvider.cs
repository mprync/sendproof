using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Tokens;

namespace Sendproof.AspNetCore.Tests;

/// <summary>
/// Implements the discovery, JWKS, authorization and token endpoints needed by the OIDC code-flow tests.
/// Both channels use this in-process HTTP transport. The authorization endpoint represents a signed-in test user.
/// </summary>
internal sealed class OidcTestIdentityProvider : HttpMessageHandler
{
    internal const string Authority = "https://login.identity.test";
    internal const string AuthorizationEndpoint = Authority + "/authorize";
    internal const string ClientId = "sendproof";
    internal const string Subject = "test-user-1";
    internal const string UserName = "Robin";

    private readonly ConcurrentDictionary<string, AuthorizationCode> _codes = new();
    private readonly string _registeredRedirectUri;
    private readonly RSA _rsa = RSA.Create(2048);
    private readonly RsaSecurityKey _signingKey;
    private int _tokenRequests;

    internal OidcTestIdentityProvider(string registeredRedirectUri)
    {
        _registeredRedirectUri = registeredRedirectUri;
        _signingKey = new RsaSecurityKey(_rsa)
        {
            KeyId = "test-key",
            CryptoProviderFactory = new CryptoProviderFactory { CacheSignatureProviders = false }
        };
    }

    internal string Role { get; init; } = "Approver";
    internal string? TokenAudience { get; init; }
    internal string? TokenNonce { get; init; }
    internal int TokenRequests => Volatile.Read(ref _tokenRequests);

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var uri = request.RequestUri!;
        if (uri.GetLeftPart(UriPartial.Authority) != Authority)
        {
            throw new InvalidOperationException("The test identity provider only serves its own HTTPS origin.");
        }

        return (request.Method.Method, uri.AbsolutePath) switch
        {
            ("GET", "/.well-known/openid-configuration") => Json(HttpStatusCode.OK, new
            {
                issuer = Authority,
                authorization_endpoint = AuthorizationEndpoint,
                token_endpoint = Authority + "/token",
                jwks_uri = Authority + "/jwks",
                scopes_supported = new[] { "openid", "profile" },
                response_types_supported = new[] { "code" },
                response_modes_supported = new[] { "query" },
                grant_types_supported = new[] { "authorization_code" },
                subject_types_supported = new[] { "public" },
                id_token_signing_alg_values_supported = new[] { "RS256" },
                token_endpoint_auth_methods_supported = new[] { "none" },
                code_challenge_methods_supported = new[] { "S256" }
            }),
            ("GET", "/jwks") => SigningKeys(),
            ("GET", "/authorize") => Authorize(uri),
            ("POST", "/token") => await RedeemAsync(request, cancellationToken),
            _ => throw new InvalidOperationException($"Unexpected identity provider request: {request.Method} {uri.AbsolutePath}")
        };
    }

    private HttpResponseMessage Authorize(Uri uri)
    {
        var query = QueryHelpers.ParseQuery(uri.Query);
        var state = query.GetValueOrDefault("state").ToString();
        var nonce = query.GetValueOrDefault("nonce").ToString();
        var challenge = query.GetValueOrDefault("code_challenge").ToString();
        var responseMode = query.GetValueOrDefault("response_mode").ToString();
        if (query.GetValueOrDefault("client_id") != ClientId || query.GetValueOrDefault("redirect_uri") != _registeredRedirectUri ||
            query.GetValueOrDefault("response_type") != "code" || responseMode is not ("" or "query") ||
            !query.GetValueOrDefault("scope").ToString().Split(' ').Contains("openid") ||
            query.GetValueOrDefault("code_challenge_method") != "S256" || challenge.Length != 43 ||
            string.IsNullOrEmpty(state) || string.IsNullOrEmpty(nonce))
        {
            return Json(HttpStatusCode.BadRequest, new { error = "invalid_request" });
        }

        var code = WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(32));
        if (!_codes.TryAdd(code, new AuthorizationCode(nonce, challenge)))
        {
            throw new InvalidOperationException("The generated authorization code must be unique.");
        }

        var callback = QueryHelpers.AddQueryString(_registeredRedirectUri, new Dictionary<string, string?>
        {
            ["code"] = code,
            ["state"] = state
        });
        return new HttpResponseMessage(HttpStatusCode.Redirect) { Headers = { Location = new Uri(callback) } };
    }

    private async Task<HttpResponseMessage> RedeemAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        Interlocked.Increment(ref _tokenRequests);
        var form = QueryHelpers.ParseQuery(await request.Content!.ReadAsStringAsync(cancellationToken));
        var verifier = form.GetValueOrDefault("code_verifier").ToString();
        var challenge = WebEncoders.Base64UrlEncode(SHA256.HashData(Encoding.ASCII.GetBytes(verifier)));
        if (form.GetValueOrDefault("grant_type") != "authorization_code" || form.GetValueOrDefault("client_id") != ClientId ||
            form.GetValueOrDefault("redirect_uri") != _registeredRedirectUri || verifier.Length is < 43 or > 128 ||
            !_codes.TryRemove(form.GetValueOrDefault("code").ToString(), out var code) || challenge != code.Challenge)
        {
            return Json(HttpStatusCode.BadRequest, new { error = "invalid_grant" });
        }

        var token = new JsonWebTokenHandler().CreateToken(new SecurityTokenDescriptor
        {
            Issuer = Authority,
            Audience = TokenAudience ?? ClientId,
            Expires = DateTime.UtcNow.AddMinutes(5),
            SigningCredentials = new SigningCredentials(_signingKey, SecurityAlgorithms.RsaSha256),
            Claims = new Dictionary<string, object>
            {
                ["sub"] = Subject,
                ["name"] = UserName,
                ["role"] = Role,
                ["nonce"] = TokenNonce ?? code.Nonce
            }
        });
        var response = Json(HttpStatusCode.OK, new
        {
            access_token = WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(32)),
            token_type = "Bearer",
            expires_in = 300,
            id_token = token
        });
        response.Headers.CacheControl = new() { NoStore = true };
        response.Headers.Pragma.ParseAdd("no-cache");
        return response;
    }

    private HttpResponseMessage SigningKeys()
    {
        var key = _rsa.ExportParameters(includePrivateParameters: false);
        return Json(HttpStatusCode.OK, new
        {
            keys = new[]
            {
                new { kty = "RSA", use = "sig", alg = "RS256", kid = _signingKey.KeyId,
                    n = WebEncoders.Base64UrlEncode(key.Modulus!), e = WebEncoders.Base64UrlEncode(key.Exponent!) }
            }
        });
    }

    private static HttpResponseMessage Json(HttpStatusCode status, object body) => new(status) { Content = JsonContent.Create(body) };

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _rsa.Dispose();
        }

        base.Dispose(disposing);
    }

    private sealed record AuthorizationCode(string Nonce, string Challenge);
}
