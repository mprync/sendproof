using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
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

        // The mysql-escape rule (spec/conformance/fixture.md "MySQL and MariaDB: mysql-escape"): after the insert, a
        // statement MySQL commits implicitly, or a procedure that commits. The adapter refuses either before sending.
        app.MapPost("/items/{id}/escape", async (string id, EscapeItemRequest body, FixtureDbContext db) =>
        {
            if (string.IsNullOrWhiteSpace(body.Name) || !System.Text.RegularExpressions.Regex.IsMatch(id, "^[A-Za-z0-9_]{1,40}$"))
                return Results.BadRequest();
            var statement = body.Via switch
            {
                "ddl" => $"CREATE TABLE sendproof_escape_{id} (n INT)",
                "call" => "CALL sendproof_commit_probe()",
                _ => null
            };
            if (statement is null) return Results.BadRequest();
            db.Items.Add(new Item { Id = id, Name = body.Name });
            await db.SaveChangesAsync();
            await db.Database.ExecuteSqlRawAsync(statement);
            return Results.Created($"/items/{Uri.EscapeDataString(id)}", new ItemResponse(id, body.Name));
        }).RequireAuthorization(policy => policy.RequireRole(AdminRole)).WithSendproofPreview()
            .WithSummary("Insert an item, then run a statement that commits on MySQL");
    }

    /// <summary>
    /// On MySQL, creates the procedure the mysql-escape rule calls: <c>sendproof_commit_probe()</c>, which runs
    /// <c>COMMIT</c>. The fixture declares no procedure as safe, so a Preview must refuse the <c>CALL</c>.
    /// </summary>
    internal static void CreateMySqlProcedures(DatabaseFacade database) =>
        database.ExecuteSqlRaw("CREATE PROCEDURE IF NOT EXISTS sendproof_commit_probe() BEGIN COMMIT; END");
}

/// <summary>Body of <c>POST /items/{id}/escape</c>: <c>via</c> is <c>ddl</c> or <c>call</c>.</summary>
public sealed record EscapeItemRequest(string? Name, string? Via);
