using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using Sendproof.AspNetCore;

namespace Sendproof.Journeys.Tests;

/// <summary>The test API: register a parcel, relabel it, read it. The generator turns these into ParcelOperations.</summary>
public static class ParcelEndpoints
{
    public static void Map(IEndpointRouteBuilder app)
    {
        var parcels = app.MapGroup("/parcels");
        parcels.MapPost("/", Register).WithName("ParcelsController.Register").Produces<ParcelView>(StatusCodes.Status201Created).WithSendproofPreview();
        parcels.MapPut("/{id:guid}/label", Relabel).WithName("ParcelsController.Relabel").Produces<ParcelView>().WithSendproofPreview();
        parcels.MapGet("/{id:guid}", Get).WithName("ParcelsController.Get").Produces<ParcelView>();
    }

    private static async Task<IResult> Register(RegisterParcelRequest request, ParcelDbContext db, SendproofPreview preview)
    {
        var parcel = new Parcel { Id = Guid.NewGuid(), Label = request.Label, Status = "Registered", CreatedAt = DateTimeOffset.UtcNow };
        db.Parcels.Add(parcel);
        await db.SaveChangesAsync();
        if (request.NotifyOwner)
        {
            preview.TryRecordEmail("Parcel registered", "parcels@example.test", ["owner@example.test"], [], $"Parcel {parcel.Label} registered", "Registered.");
        }

        return TypedResults.Created($"/parcels/{parcel.Id}", View(parcel));
    }

    private static async Task<IResult> Relabel(Guid id, RelabelRequest request, [FromHeader(Name = "X-Clerk")] string? clerk, ParcelDbContext db)
    {
        var parcel = await db.Parcels.SingleOrDefaultAsync(p => p.Id == id);
        if (parcel is null)
        {
            return TypedResults.NotFound();
        }

        // British spelling, which the journey's expectation doesn't use: the approved difference covers it.
        parcel.Label = request.Label;
        parcel.Status = clerk is null ? "Relabelled" : "Relabelled by clerk";
        await db.SaveChangesAsync();
        return TypedResults.Ok(View(parcel));
    }

    private static async Task<IResult> Get(Guid id, ParcelDbContext db) =>
        await db.Parcels.AsNoTracking().SingleOrDefaultAsync(p => p.Id == id) is { } parcel ? TypedResults.Ok(View(parcel)) : TypedResults.NotFound();

    private static ParcelView View(Parcel parcel) => new() { Id = parcel.Id, Label = parcel.Label, Status = parcel.Status };
}
