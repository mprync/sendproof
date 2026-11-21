using Microsoft.EntityFrameworkCore;
using Sendproof.AspNetCore;

namespace DotnetConformance;

/// <summary>Body of <c>POST /accounts</c>.</summary>
public sealed record CreateAccountRequest(string? Id, string? Email, string? Password);

/// <summary>Body of <c>POST /items/{id}/commit</c>.</summary>
public sealed record CommitItemRequest(string? Name);

/// <summary>
/// The shared security rules of the conformance contract (spec/conformance/fixture.md "Shared security rules"): an
/// <c>accounts</c> table whose <c>password_hash</c> captures must redact, and a route whose handler sends a raw <c>COMMIT</c>.
/// </summary>
internal static class SharedRuleEndpoints
{
    private const string AdminRole = "admin";

    internal static void MapSharedRuleEndpoints(this WebApplication app)
    {
        app.MapPost("/accounts", async (CreateAccountRequest body, FixtureDbContext db) =>
        {
            if (string.IsNullOrWhiteSpace(body.Id) || string.IsNullOrWhiteSpace(body.Email) || string.IsNullOrWhiteSpace(body.Password))
                return Results.BadRequest();
            // Test data: the runner searches captures for the literal, which must never appear in them.
            db.Accounts.Add(new Account { id = body.Id, email = body.Email, password_hash = "hashed:" + body.Password });
            await db.SaveChangesAsync();
            return Results.Created($"/accounts/{Uri.EscapeDataString(body.Id)}", new { id = body.Id, email = body.Email });
        }).RequireAuthorization(policy => policy.RequireRole(AdminRole)).WithSendproofPreview().WithSummary("Create an account");

        app.MapGet("/accounts/{id}", async (string id, FixtureDbContext db) =>
            await db.Accounts.AsNoTracking().SingleOrDefaultAsync(account => account.id == id) is { } account
                ? Results.Ok(new { id = account.id, email = account.email })
                : Results.NotFound()).RequireAuthorization().WithSummary("Get an account");

        app.MapPost("/items/{id}/commit", async (string id, CommitItemRequest body, FixtureDbContext db) =>
        {
            if (string.IsNullOrWhiteSpace(body.Name)) return Results.BadRequest();
            db.Items.Add(new Item { Id = id, Name = body.Name });
            await db.SaveChangesAsync();
            // A raw COMMIT on the connection the handler uses: the adapter refuses it during a Preview, so the Preview is
            // never confirmed and the insert rolls back with the Preview transaction.
            await db.Database.ExecuteSqlRawAsync("COMMIT");
            return Results.Created($"/items/{Uri.EscapeDataString(id)}", new ItemResponse(id, body.Name));
        }).RequireAuthorization(policy => policy.RequireRole(AdminRole)).WithSendproofPreview().WithSummary("Insert an item, then COMMIT");
    }
}
