using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;

namespace DotnetConformance;

/// <summary>A fixture identity. The email doubles as the stable authenticated subject that owns traces.</summary>
internal sealed record Persona(string Email, string Name, string Role);

/// <summary>Password sign-in and development persona switching for the fixture.</summary>
internal static class AuthEndpoints
{
    internal const string AdminPassword = "bench-fixture";
    private static readonly Persona Admin = new("admin@example.test", "Fixture Admin", "admin");
    private static readonly Persona Viewer = new("viewer@example.test", "Fixture Viewer", "viewer");
    private static readonly Persona[] Personas = [Admin, Viewer];

    internal static void MapAuthEndpoints(this WebApplication app)
    {
        app.MapPost("/auth/sign-in", async (SignInRequest request, HttpContext context) =>
        {
            if (request.Email != Admin.Email || !Matches(request.Password, AdminPassword))
                return Results.Unauthorized();
            await SignInAsync(context, Admin);
            return Results.Ok(Admin);
        }).ExcludeFromDescription();

        app.MapGet("/auth/personas", () => Personas).RequireAuthorization().ExcludeFromDescription();

        app.MapPost("/auth/personas/{email}", async (string email, HttpContext context) =>
        {
            if (Personas.SingleOrDefault(persona => persona.Email == email) is not { } persona)
                return Results.NotFound();
            await SignInAsync(context, persona);
            return Results.Ok(persona);
        }).RequireAuthorization().ExcludeFromDescription();
    }

    private static bool Matches(string? supplied, string expected) => supplied is not null &&
        CryptographicOperations.FixedTimeEquals(SHA256.HashData(Encoding.UTF8.GetBytes(supplied)), SHA256.HashData(Encoding.UTF8.GetBytes(expected)));

    private static Task SignInAsync(HttpContext context, Persona persona)
    {
        var identity = new ClaimsIdentity(
        [
            new Claim(ClaimTypes.NameIdentifier, persona.Email),
            new Claim(ClaimTypes.Name, persona.Name),
            new Claim(ClaimTypes.Email, persona.Email),
            new Claim(ClaimTypes.Role, persona.Role)
        ], CookieAuthenticationDefaults.AuthenticationScheme);
        return context.SignInAsync(CookieAuthenticationDefaults.AuthenticationScheme, new ClaimsPrincipal(identity));
    }
}

internal sealed class SignInRequest
{
    public string? Email { get; set; }
    public string? Password { get; set; }
}
