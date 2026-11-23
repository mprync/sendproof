using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Sendproof.AspNetCore;

namespace DotnetConformance;

/// <summary>Body of <c>POST /items</c>.</summary>
public sealed class CreateItemRequest
{
    /// <summary>Gets or sets the new item's string identifier.</summary>
    // Nullable with [Required]: the schema documents the field, while the handler reports a missing value as an
    // application validation problem (a binder failure would surface outside the handler as an unconfirmed preview).
    [System.ComponentModel.DataAnnotations.Required]
    public string? Id { get; set; }

    /// <summary>Gets or sets the item's name.</summary>
    [System.ComponentModel.DataAnnotations.Required]
    public string? Name { get; set; }
}

/// <summary>Body of <c>PATCH /items/{id}</c>.</summary>
public sealed class UpdateItemRequest
{
    /// <summary>Gets or sets the new name.</summary>
    [System.ComponentModel.DataAnnotations.Required]
    public string? Name { get; set; }
}

/// <summary>An item as returned by the API.</summary>
public sealed record ItemResponse(string Id, string Name);

/// <summary>The fixture's API operations. Writes need the admin role; reads need any signed-in user.</summary>
internal static class ItemEndpoints
{
    private const int CaptureItems = 201;
    private const int CaptureEffects = 101;
    private const int CaptureLogs = 501;
    private const int LargeBodyChars = 1_500_000;
    private const string AdminRole = "admin";

    internal static void MapItemEndpoints(this WebApplication app)
    {
        var items = app.MapGroup("/items").WithTags("Items");

        items.MapGet("/{id}", async (string id, bool? hold, FixtureDbContext db, CancellationToken cancellationToken) =>
        {
            // Give two concurrent session reads a bounded interval in which to overlap.
            if (hold == true) await Task.Delay(TimeSpan.FromSeconds(1), cancellationToken);
            return await db.Items.AsNoTracking().SingleOrDefaultAsync(item => item.Id == id, cancellationToken) is { } item
                ? Results.Ok(new ItemResponse(item.Id, item.Name))
                : Results.NotFound();
        })
            .RequireAuthorization().WithName("Items.Get").WithSummary("Get an item")
            .Produces<ItemResponse>().Produces(StatusCodes.Status404NotFound);

        items.MapPost("", CreateAsync)
            .RequireAuthorization(policy => policy.RequireRole(AdminRole)).WithSendproofPreview()
            .WithSummary("Create an item").Produces<ItemResponse>(StatusCodes.Status201Created)
            .ProducesValidationProblem().ProducesProblem(StatusCodes.Status409Conflict);

        items.MapPatch("/{id}", UpdateAsync)
            .RequireAuthorization(policy => policy.RequireRole(AdminRole)).WithSendproofPreview()
            .WithSummary("Rename an item").Produces<ItemResponse>().Produces(StatusCodes.Status404NotFound)
            .ProducesValidationProblem();

        items.MapDelete("/{id}", async (string id, FixtureDbContext db) =>
        {
            if (await db.Items.SingleOrDefaultAsync(item => item.Id == id) is not { } item) return Results.NotFound();
            db.Items.Remove(item);
            await db.SaveChangesAsync();
            return Results.NoContent();
        }).RequireAuthorization(policy => policy.RequireRole(AdminRole)).WithSendproofPreview()
            .WithSummary("Delete an item").Produces(StatusCodes.Status204NoContent).Produces(StatusCodes.Status404NotFound);

        items.MapPost("/{id}/fail", FailAsync)
            .RequireAuthorization(policy => policy.RequireRole(AdminRole)).WithSendproofPreview()
            .WithSummary("Insert an item, then fail (409, or an exception with ?mode=exception)")
            .ProducesProblem(StatusCodes.Status409Conflict);

        items.MapPost("/{id}/large", LargeAsync)
            .RequireAuthorization(policy => policy.RequireRole(AdminRole)).WithSendproofPreview()
            .WithSummary("Insert an item and return a body above the preview response cap")
            .Produces<LargeResponse>().ProducesProblem(StatusCodes.Status409Conflict);

        items.MapPost("/{id}/redirect", (string id, HttpRequest request, HttpResponse response) =>
        {
            // Both the redirect and the cookie belong to the inner response and must never reach the client in a preview.
            response.Headers.SetCookie = "fixture-inner=1; Path=/; HttpOnly";
            return Results.Redirect($"{request.PathBase}/items/{Uri.EscapeDataString(id)}");
        }).RequireAuthorization(policy => policy.RequireRole(AdminRole)).WithSendproofPreview()
            .WithSummary("Redirect to the item with an inner Set-Cookie").Produces(StatusCodes.Status302Found);

        items.MapPost("/{id}/capture", CaptureAsync)
            .RequireAuthorization(policy => policy.RequireRole(AdminRole)).WithSendproofPreview()
            .WithSummary("Exceed every capture limit in one request").Produces<ItemResponse>(StatusCodes.Status201Created);

        // Deliberately not marked for preview: ordinary Send only.
        items.MapPost("/{id}/ordinary", async (string id, FixtureDbContext db, HttpRequest request) =>
            await InsertAsync(db, id, $"item {id}")
                ? Results.Created($"{request.PathBase}/items/{Uri.EscapeDataString(id)}", new ItemResponse(id, $"item {id}"))
                : Duplicate(id))
            .RequireAuthorization(policy => policy.RequireRole(AdminRole))
            .WithSummary("Insert an item (not available for preview)")
            .Produces<ItemResponse>(StatusCodes.Status201Created).ProducesProblem(StatusCodes.Status409Conflict);
    }

    private static async Task<IResult> CreateAsync(CreateItemRequest body, FixtureDbContext db, HttpRequest request,
        SendproofPreview preview, FixtureOutbox outbox, ILogger<CreateItemRequest> logger)
    {
        var errors = new Dictionary<string, string[]>();
        if (string.IsNullOrWhiteSpace(body.Id)) errors["id"] = ["An id is required."];
        if (string.IsNullOrWhiteSpace(body.Name)) errors["name"] = ["A name is required."];
        if (errors.Count > 0) return Results.ValidationProblem(errors);
        var (id, name) = (body.Id!, body.Name!);
        if (!await InsertAsync(db, id, name)) return Duplicate(id);

        // A bound parameter whose name looks secret: the adapter must redact its value in captured SQL.
        // The parameter comes from the connection's own provider, so the same route runs on SQLite and MySQL.
        using var command = db.Database.GetDbConnection().CreateCommand();
        var secret = command.CreateParameter();
        secret.ParameterName = "fixture_secret";
        secret.Value = "fixture-secret-value";
        await db.Database.ExecuteSqlRawAsync("SELECT @fixture_secret", secret);
        Notify(preview, outbox, "Created item", $"Item {id} was created.");
        logger.LogInformation("created:{ItemId}", id);
        return Results.Created($"{request.PathBase}/items/{Uri.EscapeDataString(id)}", new ItemResponse(id, name));
    }

    private static async Task<IResult> UpdateAsync(string id, UpdateItemRequest body, [FromQuery] string? tag,
        FixtureDbContext db, HttpResponse response)
    {
        if (string.IsNullOrWhiteSpace(body.Name))
            return Results.ValidationProblem(new Dictionary<string, string[]> { ["name"] = ["A name is required."] });
        if (await db.Items.SingleOrDefaultAsync(item => item.Id == id) is not { } item) return Results.NotFound();
        item.Name = body.Name!;
        await db.SaveChangesAsync();
        if (tag is not null) response.Headers["X-Fixture-Tag"] = tag;
        return Results.Ok(new ItemResponse(item.Id, item.Name));
    }

    private static async Task<IResult> FailAsync(string id, [FromQuery] string? mode, FixtureDbContext db)
    {
        if (!await InsertAsync(db, id, $"item {id}")) return Duplicate(id);
        if (mode == "exception") throw new InvalidOperationException("Injected fixture failure.");
        return Results.Problem(statusCode: StatusCodes.Status409Conflict, title: "The operation failed after writing.");
    }

    private static async Task<IResult> LargeAsync(string id, FixtureDbContext db)
    {
        if (!await InsertAsync(db, id, $"item {id}")) return Duplicate(id);
        return Results.Ok(new LargeResponse(id, new string('x', LargeBodyChars)));
    }

    private static async Task<IResult> CaptureAsync(string id, FixtureDbContext db, HttpRequest request,
        SendproofPreview preview, FixtureOutbox outbox, ILogger<CreateItemRequest> logger)
    {
        for (var n = 0; n < CaptureItems; n++)
            db.Items.Add(new Item { Id = $"{id}-{n}", Name = $"item {id}-{n}" });
        try
        {
            await db.SaveChangesAsync();
        }
        catch (DbUpdateException)
        {
            return Duplicate(id);
        }

        for (var n = 0; n < CaptureEffects; n++)
            Notify(preview, outbox, $"Capture effect {n}", $"Capture effect {n} for {id}.");
        for (var n = 0; n < CaptureLogs; n++)
            logger.LogInformation("capture:{Index}", n);
        return Results.Created($"{request.PathBase}/items/{Uri.EscapeDataString(id)}-0", new ItemResponse($"{id}-0", $"item {id}-0"));
    }

    /// <summary>Records an email effect. Ordinary Send and observed Send deliver it; Preview suppresses it.</summary>
    private static void Notify(SendproofPreview preview, FixtureOutbox outbox, string description, string text)
    {
        if (!preview.TryRecordEmail(description, "bench@example.test", ["ops@example.test"], [], description, text))
            outbox.Deliver(description);
    }

    private static async Task<bool> InsertAsync(FixtureDbContext db, string id, string name)
    {
        if (await db.Items.AnyAsync(item => item.Id == id)) return false;
        db.Items.Add(new Item { Id = id, Name = name });
        await db.SaveChangesAsync();
        return true;
    }

    private static IResult Duplicate(string id) =>
        Results.Problem(statusCode: StatusCodes.Status409Conflict, title: $"Item '{id}' already exists.");
}

/// <summary>Response of <c>POST /items/{id}/large</c>.</summary>
public sealed record LargeResponse(string Id, string Payload);
