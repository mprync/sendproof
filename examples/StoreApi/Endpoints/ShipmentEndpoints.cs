using System.Security.Claims;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Sendproof.AspNetCore;

namespace StoreApi;

/// <summary>The shipment operations: list and read shipments, and create one for a paid order.</summary>
internal static class ShipmentEndpoints
{
    internal static void MapShipmentEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/v2/shipments").WithTags("Shipments");
        group.MapGet("/", List).WithName("ShipmentsController.List").RequireAuthorization(Policies.Staff)
            .WithMetadata(new SortKeysMetadata(SortKeys.Shipments)).Produces<PagedList<Shipment>>().ProducesValidationProblem();
        group.MapGet("/{id:guid}", Get).WithName("ShipmentsController.Get").RequireAuthorization()
            .Produces<Shipment>().ProducesProblem(StatusCodes.Status403Forbidden).ProducesProblem(StatusCodes.Status404NotFound);
        group.MapPost("/", Create).WithName("ShipmentsController.Create").RequireAuthorization(Policies.Warehouse)
            .Produces<Shipment>(StatusCodes.Status201Created).ProducesValidationProblem().ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity).WithSendproofPreview();
    }

    /// <summary>List shipments</summary>
    /// <remarks>Returns parcels with their scans, most recently shipped first. Requires the `admin`, `support` or `warehouse` role.</remarks>
    /// <param name="page">The 1-based page number.</param>
    /// <param name="pageSize">How many shipments to return per page, from 1 to 100.</param>
    /// <param name="status">Only shipments in this status.</param>
    /// <param name="carrier">Only shipments with this carrier.</param>
    /// <param name="orderId">Only the shipments of this order.</param>
    /// <param name="sort">The sort order: a field name, with a leading minus for descending. Defaults to `-shippedAt`.</param>
    /// <response code="200">A page of shipments.</response>
    /// <response code="400">A paging or sort value was invalid.</response>
    internal static async Task<IResult> List(StoreDbContext db, int page = 1, int pageSize = EndpointSupport.DefaultPageSize,
        ShipmentStatus? status = null, Carrier? carrier = null, Guid? orderId = null, string? sort = null)
    {
        var errors = new Dictionary<string, string[]>();
        EndpointSupport.CheckPaging(page, pageSize, errors);
        EndpointSupport.CheckSort(sort, SortKeys.Shipments, errors);
        if (errors.Count > 0) return Results.ValidationProblem(errors);
        var query = db.Shipments.AsNoTracking().AsQueryable();
        if (status is { } s) query = query.Where(x => x.Status == s);
        if (carrier is { } c) query = query.Where(x => x.Carrier == c);
        if (orderId is { } o) query = query.Where(x => x.OrderId == o);
        var ordered = sort == "shippedAt" ? EndpointSupport.Sorted(query, false, x => x.ShippedAt, x => x.Id) : EndpointSupport.Sorted(query, true, x => x.ShippedAt, x => x.Id);
        return TypedResults.Ok(await EndpointSupport.PageAsync(ordered, page, pageSize, async rows => await rows.ToContractsAsync(db)));
    }

    /// <summary>Get shipment</summary>
    /// <remarks>Returns one shipment with every scan the carrier reported. A customer can read only the shipments of their own orders.</remarks>
    /// <param name="id">The shipment's ID, from `ShipmentsController.List` or an order's `shipments`.</param>
    /// <response code="200">The shipment.</response>
    /// <response code="403">You are a customer and this shipment belongs to somebody else's order.</response>
    /// <response code="404">No shipment has this ID.</response>
    internal static async Task<IResult> Get(Guid id, StoreDbContext db, ClaimsPrincipal principal)
    {
        var shipment = await db.Shipments.AsNoTracking().SingleOrDefaultAsync(s => s.Id == id);
        if (shipment is null) return EndpointSupport.NotFound("shipment", id);
        var customer = await (from o in db.Orders.AsNoTracking() join c in db.Customers.AsNoTracking() on o.CustomerId equals c.Id where o.Id == shipment.OrderId select c).SingleAsync();
        return principal.CanActFor(customer) ? TypedResults.Ok(await shipment.ToContractAsync(db)) : EndpointSupport.Forbidden(EndpointSupport.NotYours);
    }

    /// <summary>Create shipment</summary>
    /// <remarks>
    /// Hands a paid order to a carrier. The order moves to `Shipped`, gets a tracking number, and the customer is emailed. The estimated delivery
    /// defaults from the order's shipping speed (`Standard` 4 days, `Express` 2, `Next day` 1).
    ///
    /// An order that is not paid yet cannot ship (422); an order that already has a shipment, or was cancelled, answers 409.
    /// Requires the `admin` or `warehouse` role.
    /// </remarks>
    /// <param name="request">The order and carrier.</param>
    /// <response code="201">The shipment was created. The `Location` header points to it.</response>
    /// <response code="400">A field was invalid.</response>
    /// <response code="409">The order already shipped or was cancelled.</response>
    /// <response code="422">The order has not been paid.</response>
    internal static async Task<IResult> Create(CreateShipmentRequest request, StoreDbContext db, ClaimsPrincipal principal,
        DemoStores stores, DemoNotificationQueue notifications, SendproofPreview preview)
    {
        var errors = new Dictionary<string, string[]>();
        if (!Enum.TryParse<Carrier>(request.Carrier, false, out var carrier) || !Enum.IsDefined(carrier)) errors["carrier"] = ["Use Ups, Dhl, FedEx, RoyalMail or CanadaPost."];
        var order = await db.Orders.SingleOrDefaultAsync(o => o.Id == request.OrderId);
        if (order is null) errors["orderId"] = ["Choose an existing order."];
        if (errors.Count > 0) return Results.ValidationProblem(errors);
        if (order!.Status is OrderStatus.Cancelled or OrderStatus.Refunded) return EndpointSupport.Conflict($"A {order.Status} order cannot ship.");
        if (order.Status is OrderStatus.Shipped or OrderStatus.Delivered) return EndpointSupport.Conflict($"The order is already {order.Status}.");
        if (order.Status == OrderStatus.Pending) return EndpointSupport.Unprocessable("The order is not paid yet. Ship it once its payment is captured.");

        var now = DateTimeOffset.UtcNow;
        var days = order.ShippingSpeed switch { ShippingSpeed.Standard => 4, ShippingSpeed.Express => 2, _ => 1 };
        var estimated = request.EstimatedDelivery ?? DateOnly.FromDateTime(now.UtcDateTime.AddDays(days));
        if (estimated < DateOnly.FromDateTime(now.UtcDateTime)) return Results.ValidationProblem(new Dictionary<string, string[]> { ["estimatedDelivery"] = ["The estimated delivery cannot be in the past."] });
        var shipment = new ShipmentRecord
        {
            Id = Guid.NewGuid(), OrderId = order.Id, Carrier = carrier, TrackingNumber = TrackingNumber(carrier, order.Number), Status = ShipmentStatus.LabelCreated,
            EventsJson = JsonSerializer.Serialize(new[] { new TrackingEvent { At = now, Location = "Dublin, IE", Description = "Label created; the parcel is ready for collection." } }),
            ShippedAt = now, EstimatedDelivery = estimated
        };
        db.Shipments.Add(shipment);
        order.Status = OrderStatus.Shipped;
        order.UpdatedAt = now;
        db.Audit("Order", order.Id, $"Order.Shipped: {carrier}", principal.Email());
        await db.SaveChangesAsync();
        await stores.RecordOrderEventsAsync(order.Id, order.Number, order.Status.ToString(),
            new ActorReference { Email = principal.Email(), Name = principal.DisplayName() },
            [("Shipment.Created", now, $"Shipped with {carrier}, tracking {shipment.TrackingNumber}.")]);
        var customer = await db.Customers.AsNoTracking().SingleAsync(c => c.Id == order.CustomerId);
        notifications.ShipmentCreated(order, shipment, customer.Email, preview);
        return TypedResults.Created($"/api/v2/shipments/{shipment.Id}", await shipment.ToContractAsync(db));
    }

    /// <summary>A tracking number in the style of the carrier, derived from the order number so it is stable.</summary>
    internal static string TrackingNumber(Carrier carrier, string orderNumber)
    {
        var digits = orderNumber[^6..];
        return carrier switch
        {
            Carrier.Ups => $"1Z999AA10{digits}8401",
            Carrier.Dhl => $"JD01460{digits}93",
            Carrier.FedEx => $"7712{digits}0937",
            Carrier.RoyalMail => $"RM{digits}4821GB",
            _ => $"CP{digits}2210CA"
        };
    }
}
