using System.Security.Claims;
using Microsoft.EntityFrameworkCore;
using Sendproof.AspNetCore;

namespace StoreApi;

/// <summary>The inventory operations: stock levels, their movements, adjustments and the reservations that hold stock.</summary>
internal static class InventoryEndpoints
{
    /// <summary>How the retired v1 stock operation is replaced.</summary>
    private static readonly DeprecationMetadata LegacyStockRetirement = new(
        [
            new("ProductsController.Get", "The product's variants, each with how many units are available.", new Dictionary<string, string> { ["id"] = "$request.path.id" }),
            new("StockController.List", "Every variant's stock level in one call, with warehouse and reorder point.")
        ],
        new DateOnly(2027, 3, 31));

    internal static void MapInventoryEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/v2/stock").WithTags("Inventory");
        group.MapGet("/", List).WithName("StockController.List").RequireAuthorization(Policies.Staff)
            .WithMetadata(new SortKeysMetadata(SortKeys.Stock)).Produces<PagedList<StockLevel>>().ProducesValidationProblem();
        group.MapGet("/{sku}", Get).WithName("StockController.Get").RequireAuthorization(Policies.Staff)
            .Produces<StockLevel>().ProducesProblem(StatusCodes.Status404NotFound);
        group.MapPost("/{sku}/adjustments", Adjust).WithName("StockController.Adjust").RequireAuthorization(Policies.Warehouse)
            .Produces<StockLevel>().ProducesValidationProblem().ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict).WithSendproofPreview();
        group.MapGet("/{sku}/movements", Movements).WithName("StockController.Movements").RequireAuthorization(Policies.Staff)
            .Produces<IReadOnlyList<StockMovement>>().ProducesProblem(StatusCodes.Status404NotFound);
        app.MapGet("/api/v2/reservations", Reservations).WithTags("Inventory").WithName("StockController.Reservations")
            .RequireAuthorization(Policies.Staff).Produces<PagedList<Reservation>>().ProducesValidationProblem();
        app.MapGet("/api/v2/products/{id:guid}/stock", LegacyLevel).WithTags("Inventory").WithName("StockController.LegacyLevel")
            .RequireAuthorization(Policies.Staff).WithMetadata(new ObsoleteAttribute("Use GET /api/v2/products/{id}."), LegacyStockRetirement)
            .Produces<LegacyStockLevel>().ProducesProblem(StatusCodes.Status404NotFound);
    }

    /// <summary>List stock levels</summary>
    /// <remarks>
    /// Returns how much of every variant the warehouse holds. *Available* is what can be bought now: units on the shelf minus
    /// the units reserved for carts and unshipped orders. Use `low=true` to list what needs reordering.
    /// Requires the `admin`, `support` or `warehouse` role.
    /// </remarks>
    /// <param name="page">The 1-based page number.</param>
    /// <param name="pageSize">How many levels to return per page, from 1 to 100.</param>
    /// <param name="q">Search text matched against the SKU, variant and product name.</param>
    /// <param name="low">Only levels at or below their reorder point (`true`), or only healthy ones (`false`).</param>
    /// <param name="warehouse">Only this warehouse, such as `DUB-01`.</param>
    /// <param name="sort">The sort order: a field name, with a leading minus for descending. Defaults to `sku`.</param>
    /// <response code="200">A page of stock levels.</response>
    /// <response code="400">A paging or sort value was invalid.</response>
    internal static async Task<IResult> List(StoreDbContext db, int page = 1, int pageSize = EndpointSupport.DefaultPageSize,
        string? q = null, bool? low = null, string? warehouse = null, string? sort = null)
    {
        var errors = new Dictionary<string, string[]>();
        EndpointSupport.CheckPaging(page, pageSize, errors);
        EndpointSupport.CheckSort(sort, SortKeys.Stock, errors);
        if (errors.Count > 0) return Results.ValidationProblem(errors);

        var query = db.Stock.AsNoTracking().AsQueryable();
        if (!string.IsNullOrWhiteSpace(warehouse)) query = query.Where(s => s.Warehouse == warehouse);
        if (low is { } isLow) query = query.Where(s => (s.OnHand - s.Reserved <= s.ReorderPoint) == isLow);
        if (!string.IsNullOrWhiteSpace(q))
        {
            var pattern = EndpointSupport.LikePattern(q);
            query = query.Where(s => db.Variants.Any(v => v.Id == s.VariantId && (EF.Functions.Like(v.Sku, pattern, "\\") ||
                EF.Functions.Like(v.Name, pattern, "\\") || db.Products.Any(p => p.Id == v.ProductId && EF.Functions.Like(p.Name, pattern, "\\")))));
        }
        var ordered = (sort ?? "sku") switch
        {
            "-sku" => EndpointSupport.Sorted(query, true, s => db.Variants.Where(v => v.Id == s.VariantId).Select(v => v.Sku).FirstOrDefault(), s => s.Id),
            "available" => EndpointSupport.Sorted(query, false, s => s.OnHand - s.Reserved, s => s.Id),
            "-available" => EndpointSupport.Sorted(query, true, s => s.OnHand - s.Reserved, s => s.Id),
            _ => EndpointSupport.Sorted(query, false, s => db.Variants.Where(v => v.Id == s.VariantId).Select(v => v.Sku).FirstOrDefault(), s => s.Id)
        };
        return TypedResults.Ok(await EndpointSupport.PageAsync(ordered, page, pageSize, async rows => await rows.ToLevelsAsync(db)));
    }

    /// <summary>Get stock level</summary>
    /// <remarks>Returns the stock of one variant: units on hand, reserved and available, the reorder point and the warehouse. Requires the `admin`, `support` or `warehouse` role.</remarks>
    /// <param name="sku">The variant's SKU, from `StockController.List`.</param>
    /// <response code="200">The stock level.</response>
    /// <response code="404">No variant has this SKU.</response>
    internal static async Task<IResult> Get(string sku, StoreDbContext db)
    {
        var variant = await db.Variants.AsNoTracking().SingleOrDefaultAsync(v => v.Sku == sku);
        if (variant is null) return EndpointSupport.NotFound("variant", sku);
        var stock = await db.Stock.AsNoTracking().SingleAsync(s => s.VariantId == variant.Id);
        return TypedResults.Ok((await new[] { stock }.ToLevelsAsync(db))[0]);
    }

    /// <summary>Adjust stock</summary>
    /// <remarks>
    /// Adds or removes units after a delivery, a return, a count or a breakage, and records the movement. The level cannot fall below what is
    /// reserved. When the available units drop to the reorder point, a reorder job is queued with purchasing. Requires the `admin` or `warehouse` role.
    /// Preview shows the stock and movement rows, the SQL and the reorder job, then rolls everything back.
    /// </remarks>
    /// <param name="sku">The variant's SKU.</param>
    /// <param name="request">The change to apply.</param>
    /// <response code="200">The stock level after the change.</response>
    /// <response code="400">The change was zero or the reason was invalid.</response>
    /// <response code="404">No variant has this SKU.</response>
    /// <response code="409">The change would take the level below the reserved units.</response>
    internal static async Task<IResult> Adjust(string sku, AdjustStockRequest request, StoreDbContext db, ClaimsPrincipal principal,
        DemoNotificationQueue notifications, SendproofPreview preview)
    {
        var errors = EndpointSupport.Validate(request);
        if (request.Delta == 0) errors["delta"] = ["The change cannot be zero."];
        if (!Enum.TryParse<StockReason>(request.Reason, false, out var reason) || !Enum.IsDefined(reason) || reason == StockReason.Sold)
            errors["reason"] = ["Use Received, Returned, Adjustment or Damaged."];
        else if (reason is StockReason.Received or StockReason.Returned && request.Delta < 0) errors["delta"] = [$"A {reason} change must add units."];
        else if (reason == StockReason.Damaged && request.Delta > 0) errors["delta"] = ["A Damaged change must remove units."];
        if (errors.Count > 0) return Results.ValidationProblem(errors);

        var variant = await db.Variants.AsNoTracking().SingleOrDefaultAsync(v => v.Sku == sku);
        if (variant is null) return EndpointSupport.NotFound("variant", sku);
        var stock = await db.Stock.SingleAsync(s => s.VariantId == variant.Id);
        if (stock.OnHand + request.Delta < stock.Reserved)
            return EndpointSupport.Conflict($"{stock.Reserved} units are reserved, so the level cannot go below {stock.Reserved}; it would be {stock.OnHand + request.Delta}.");
        stock.OnHand += request.Delta;
        stock.UpdatedAt = DateTimeOffset.UtcNow;
        db.StockMovements.Add(new StockMovementRecord
        {
            Id = Guid.NewGuid(), VariantId = variant.Id, Delta = request.Delta, Reason = reason, Reference = request.Reference,
            Actor = principal.Email(), CreatedAt = stock.UpdatedAt
        });
        db.Audit("Stock", variant.Id, $"Stock.Adjusted: {request.Delta:+#;-#}", principal.Email());
        await db.SaveChangesAsync();
        if (stock.OnHand - stock.Reserved <= stock.ReorderPoint) notifications.StockLow(sku, stock.OnHand - stock.Reserved, preview);
        return TypedResults.Ok((await new[] { stock }.ToLevelsAsync(db))[0]);
    }

    /// <summary>List stock movements</summary>
    /// <remarks>Returns every change to a variant's stock, newest first: deliveries, sales, returns, counts and write-offs, each with who moved it and why.</remarks>
    /// <param name="sku">The variant's SKU, from `StockController.List`.</param>
    /// <response code="200">The movements, newest first (up to 100).</response>
    /// <response code="404">No variant has this SKU.</response>
    internal static async Task<IResult> Movements(string sku, StoreDbContext db)
    {
        var variant = await db.Variants.AsNoTracking().SingleOrDefaultAsync(v => v.Sku == sku);
        if (variant is null) return EndpointSupport.NotFound("variant", sku);
        var rows = (await db.StockMovements.AsNoTracking().Where(m => m.VariantId == variant.Id).ToListAsync()).OrderByDescending(m => m.CreatedAt).Take(100);
        return TypedResults.Ok<IReadOnlyList<StockMovement>>(rows.Select(m => new StockMovement
        {
            Id = m.Id, Delta = m.Delta, Reason = m.Reason, Reference = m.Reference, Actor = m.Actor, CreatedAt = m.CreatedAt
        }).ToList());
    }

    /// <summary>List reservations</summary>
    /// <remarks>
    /// Returns the stock held for shoppers. A **held** reservation belongs to a cart and expires after 15 minutes; a **committed** one belongs
    /// to a placed order. Use it to see why a variant's available units are lower than its units on hand.
    /// </remarks>
    /// <param name="page">The 1-based page number.</param>
    /// <param name="pageSize">How many reservations to return per page, from 1 to 100.</param>
    /// <param name="status">Only reservations with this status.</param>
    /// <param name="sku">Only reservations of this variant.</param>
    /// <response code="200">A page of reservations, newest first.</response>
    /// <response code="400">A paging value was invalid.</response>
    internal static async Task<IResult> Reservations(StoreDbContext db, int page = 1, int pageSize = EndpointSupport.DefaultPageSize,
        ReservationStatus? status = null, string? sku = null)
    {
        var errors = new Dictionary<string, string[]>();
        EndpointSupport.CheckPaging(page, pageSize, errors);
        if (errors.Count > 0) return Results.ValidationProblem(errors);
        var query = db.Reservations.AsNoTracking().AsQueryable();
        if (status is { } s) query = query.Where(r => r.Status == s);
        if (!string.IsNullOrWhiteSpace(sku)) query = query.Where(r => db.Variants.Any(v => v.Id == r.VariantId && v.Sku == sku));
        var ordered = EndpointSupport.Sorted(query, true, r => r.CreatedAt, r => r.Id);
        return TypedResults.Ok(await EndpointSupport.PageAsync(ordered, page, pageSize, async rows =>
        {
            var names = await db.VariantReferencesAsync(rows.Select(r => r.VariantId));
            return (IReadOnlyList<Reservation>)rows.Select(r => new Reservation
            {
                Id = r.Id, Variant = names[r.VariantId], Quantity = r.Quantity, Status = r.Status, OrderId = r.OrderId,
                ExpiresAt = r.ExpiresAt, CreatedAt = r.CreatedAt
            }).ToList();
        }));
    }

    /// <summary>Get product stock (v1)</summary>
    /// <remarks>
    /// **Deprecated.** Returns one number for the whole product. Use `ProductsController.Get`, whose variants each report `available`, or
    /// `StockController.List` for the warehouse view. The response carries a `Deprecation` header, a `Sunset` header and a `Link` to its replacement.
    /// </remarks>
    /// <param name="id">The product's ID.</param>
    /// <param name="context">The current HTTP context, used to add the deprecation headers.</param>
    /// <response code="200">The units available across all variants.</response>
    /// <response code="404">No product has this ID.</response>
    internal static async Task<IResult> LegacyLevel(Guid id, StoreDbContext db, HttpContext context)
    {
        if (!await db.Products.AnyAsync(p => p.Id == id)) return EndpointSupport.NotFound("product", id);
        context.Response.Headers["Deprecation"] = "true";
        context.Response.Headers["Sunset"] = LegacyStockRetirement.SunsetHttpDate;
        context.Response.Headers.Link = $"</api/v2/products/{id}>; rel=\"successor-version\"";
        var rows = await (from v in db.Variants.AsNoTracking() join s in db.Stock.AsNoTracking() on v.Id equals s.VariantId where v.ProductId == id select s).ToListAsync();
        return TypedResults.Ok(new LegacyStockLevel { ProductId = id, Quantity = rows.Sum(s => s.OnHand - s.Reserved) });
    }
}
