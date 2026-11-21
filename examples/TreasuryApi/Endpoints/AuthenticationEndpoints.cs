using System.Security.Claims;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;

namespace TreasuryApi;

/// <summary>Sign-in, sign-out and the development-only persona switcher the workbench uses.</summary>
internal static class AuthenticationEndpoints
{
    internal static void MapAuthenticationEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/auth").WithTags("Authentication");
        group.MapPost("/login", Login).WithName("AuthController.Login")
            .Produces<Persona>().ProducesProblem(StatusCodes.Status401Unauthorized);
        group.MapGet("/me", Me).WithName("AuthController.Me").RequireAuthorization().Produces<Persona>();
        group.MapPost("/logout", Logout).WithName("AuthController.Logout").Produces(StatusCodes.Status204NoContent);

        if (!app.Environment.IsDevelopment()) return;
        group.MapGet("/personas", Personas).WithName("AuthController.Personas").Produces<IEnumerable<Persona>>();
        group.MapPost("/personas/{email}", SwitchPersona).WithName("AuthController.SwitchPersona")
            .Produces<Persona>().ProducesProblem(StatusCodes.Status404NotFound);
    }

    /// <summary>Sign in with a password</summary>
    /// <remarks>
    /// Checks the email and password and starts a session. The browser keeps the session cookie, so later
    /// requests are signed in. Every seeded user has the demo password `Demo123!`.
    ///
    /// In development you can skip the password with `AuthController.SwitchPersona`.
    /// </remarks>
    /// <param name="request">The email address and password.</param>
    /// <response code="200">Signed in. The response says who you are.</response>
    /// <response code="401">The email or password is wrong, or the user is deactivated.</response>
    internal static async Task<IResult> Login(LoginRequest request, TreasuryDbContext db, IPasswordHasher<DemoUser> hasher, HttpContext context)
    {
        var email = request.Email?.Trim().ToLowerInvariant();
        var user = await db.Users.SingleOrDefaultAsync(u => u.Email == email);
        if (user is null || !user.IsActive || request.Password is null ||
            hasher.VerifyHashedPassword(user, user.PasswordHash, request.Password) == PasswordVerificationResult.Failed)
            return Results.Problem(title: "Sign-in failed", detail: "The email or password is wrong.", statusCode: StatusCodes.Status401Unauthorized);
        await SignInAsync(context, user);
        return TypedResults.Ok(Persona.From(user));
    }

    /// <summary>Get the current user</summary>
    /// <remarks>Returns the identity and role of the signed-in user. Use it to check which session the browser holds.</remarks>
    /// <response code="200">The signed-in user.</response>
    internal static IResult Me(ClaimsPrincipal principal) => TypedResults.Ok(new Persona
    {
        Email = principal.Email(), Name = principal.DisplayName(), Role = principal.FindFirstValue(ClaimTypes.Role)!
    });

    /// <summary>Sign out</summary>
    /// <remarks>Ends the session and clears the session cookie.</remarks>
    /// <response code="204">Signed out.</response>
    internal static async Task<IResult> Logout(HttpContext context, CancellationToken cancellationToken)
    {
        await context.SignOutAsync();
        return Results.NoContent();
    }

    /// <summary>List development personas</summary>
    /// <remarks>Lists the seeded users, so the workbench can offer them in its persona picker. Available in development only.</remarks>
    /// <response code="200">The seeded users.</response>
    internal static async Task<IResult> Personas(TreasuryDbContext db) =>
        TypedResults.Ok((await db.Users.AsNoTracking().OrderBy(u => u.Id).ToListAsync()).Select(Persona.From));

    /// <summary>Switch to a development persona</summary>
    /// <remarks>Signs in as a seeded user without a password. Available in development only.</remarks>
    /// <param name="email">The seeded user's email address, URL-encoded.</param>
    /// <response code="200">Signed in as that user.</response>
    /// <response code="404">No seeded user has this email address.</response>
    internal static async Task<IResult> SwitchPersona(string email, TreasuryDbContext db, HttpContext context)
    {
        var user = await db.Users.SingleOrDefaultAsync(u => u.Email == email.ToLowerInvariant());
        if (user is null) return EndpointSupport.NotFound("user", email);
        await SignInAsync(context, user);
        return TypedResults.Ok(Persona.From(user));
    }

    private static Task SignInAsync(HttpContext context, DemoUser user)
    {
        var identity = new ClaimsIdentity([
            new Claim(ClaimTypes.NameIdentifier, user.Id.ToString()),
            new Claim(ClaimTypes.Name, user.Name),
            new Claim(ClaimTypes.Email, user.Email),
            new Claim(ClaimTypes.Role, user.Role)
        ], CookieAuthenticationDefaults.AuthenticationScheme);
        return context.SignInAsync(CookieAuthenticationDefaults.AuthenticationScheme, new ClaimsPrincipal(identity));
    }
}

/// <summary>Credentials for the demo's cookie sign-in.</summary>
public sealed class LoginRequest
{
    /// <summary>The user's email address.</summary>
    public required string Email { get; init; }
    /// <summary>The user's password.</summary>
    public required string Password { get; init; }
}

/// <summary>Identity and role displayed in the workbench.</summary>
public sealed class Persona
{
    /// <summary>The user's email address.</summary>
    public required string Email { get; init; }
    /// <summary>The user's display name.</summary>
    public required string Name { get; init; }
    /// <summary>The user's role: `admin`, `payments.approve` or `read-only`.</summary>
    public required string Role { get; init; }

    internal static Persona From(DemoUser user) => new() { Email = user.Email, Name = user.Name, Role = user.Role };
}
