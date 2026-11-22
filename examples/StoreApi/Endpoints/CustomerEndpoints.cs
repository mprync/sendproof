using System.Security.Claims;
using Microsoft.EntityFrameworkCore;
using Sendproof.AspNetCore;

namespace StoreApi;

/// <summary>The customer operations: list, read, register and update customers, and manage their saved addresses.</summary>
internal static class CustomerEndpoints
{
    internal static void MapCustomerEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/v2/customers").WithTags("Customers");
        group.MapGet("/", List).WithName("CustomersController.List").RequireAuthorization(Policies.Support)
            .WithMetadata(new SortKeysMetadata(SortKeys.Customers)).Produces<PagedList<Customer>>().ProducesValidationProblem();
        group.MapGet("/{id:guid}", Get).WithName("CustomersController.Get").RequireAuthorization()
            .Produces<Customer>().ProducesProblem(StatusCodes.Status403Forbidden).ProducesProblem(StatusCodes.Status404NotFound);
        // Registration is public: a shopper creates a profile before they have anything to sign in with.
        group.MapPost("/", Register).WithName("CustomersController.Register")
            .Produces<Customer>(StatusCodes.Status201Created).ProducesValidationProblem().ProducesProblem(StatusCodes.Status409Conflict)
            .WithSendproofPreview();
        group.MapPut("/{id:guid}", Update).WithName("CustomersController.Update").RequireAuthorization()
            .Produces<Customer>().ProducesValidationProblem().ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status404NotFound).WithSendproofPreview();
        group.MapGet("/{id:guid}/addresses", Addresses).WithName("CustomersController.Addresses").RequireAuthorization()
            .Produces<IReadOnlyList<CustomerAddress>>().ProducesProblem(StatusCodes.Status403Forbidden).ProducesProblem(StatusCodes.Status404NotFound);
        group.MapPost("/{id:guid}/addresses", AddAddress).WithName("CustomersController.AddAddress").RequireAuthorization()
            .Produces<CustomerAddress>(StatusCodes.Status201Created).ProducesValidationProblem().ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status404NotFound).WithSendproofPreview();
    }

    /// <summary>List customers</summary>
    /// <remarks>
    /// Returns the store's customers with how many orders each placed and what they spent, alphabetical unless you pass `sort`.
    /// Requires the `admin` or `support` role; customers read their own profile with `CustomersController.Get`.
    /// </remarks>
    /// <param name="page">The 1-based page number.</param>
    /// <param name="pageSize">How many customers to return per page, from 1 to 100.</param>
    /// <param name="q">Search text matched against name, email and phone.</param>
    /// <param name="tier">Only customers in this loyalty tier.</param>
    /// <param name="currency">Only customers who shop in this currency.</param>
    /// <param name="sort">The sort order: a field name, with a leading minus for descending. Defaults to `name`.</param>
    /// <response code="200">A page of customers.</response>
    /// <response code="400">A paging or sort value was invalid.</response>
    internal static async Task<IResult> List(StoreDbContext db, int page = 1, int pageSize = EndpointSupport.DefaultPageSize,
        string? q = null, CustomerTier? tier = null, Currency? currency = null, string? sort = null)
    {
        var errors = new Dictionary<string, string[]>();
        EndpointSupport.CheckPaging(page, pageSize, errors);
        EndpointSupport.CheckSort(sort, SortKeys.Customers, errors);
        if (errors.Count > 0) return Results.ValidationProblem(errors);
        var query = db.Customers.AsNoTracking().AsQueryable();
        if (tier is { } t) query = query.Where(c => c.Tier == t);
        if (currency is { } cur) query = query.Where(c => c.PreferredCurrency == cur);
        if (!string.IsNullOrWhiteSpace(q))
        {
            var pattern = EndpointSupport.LikePattern(q);
            query = query.Where(c => EF.Functions.Like(c.FirstName + " " + c.LastName, pattern, "\\") ||
                EF.Functions.Like(c.Email, pattern, "\\") || EF.Functions.Like(c.Phone!, pattern, "\\"));
        }
        var ordered = (sort ?? "name") switch
        {
            "-name" => EndpointSupport.Sorted(query, true, c => c.LastName + c.FirstName, c => c.Id),
            "createdAt" => EndpointSupport.Sorted(query, false, c => c.CreatedAt, c => c.Id),
            "-createdAt" => EndpointSupport.Sorted(query, true, c => c.CreatedAt, c => c.Id),
            _ => EndpointSupport.Sorted(query, false, c => c.LastName + c.FirstName, c => c.Id)
        };
        return TypedResults.Ok(await EndpointSupport.PageAsync(ordered, page, pageSize, async rows => await rows.ToContractsAsync(db)));
    }

    /// <summary>Get customer</summary>
    /// <remarks>Returns one customer. Staff can read any customer; a customer can read only themselves (anyone else gets 403).</remarks>
    /// <param name="id">The customer's ID, from `CustomersController.List`.</param>
    /// <response code="200">The customer.</response>
    /// <response code="403">You are a customer and this is somebody else's profile.</response>
    /// <response code="404">No customer has this ID.</response>
    internal static async Task<IResult> Get(Guid id, StoreDbContext db, ClaimsPrincipal principal)
    {
        var customer = await db.Customers.AsNoTracking().SingleOrDefaultAsync(c => c.Id == id);
        if (customer is null) return EndpointSupport.NotFound("customer", id);
        return principal.CanActFor(customer) ? TypedResults.Ok(await customer.ToContractAsync(db)) : EndpointSupport.Forbidden(EndpointSupport.NotYours);
    }

    /// <summary>Register customer</summary>
    /// <remarks>
    /// Creates a customer profile and sends a welcome email with a 10% coupon. **Public**: no sign-in needed. A new customer shops in
    /// their `preferredCurrency` and starts in the `Standard` tier.
    ///
    /// The email address must not be registered already, otherwise the answer is 409. Preview shows the row it would add and the welcome email held back.
    /// </remarks>
    /// <param name="request">The customer to register.</param>
    /// <response code="201">The customer was registered. The `Location` header points to them.</response>
    /// <response code="400">A field was missing or invalid.</response>
    /// <response code="409">A customer with this email address already exists.</response>
    internal static async Task<IResult> Register(RegisterCustomerRequest request, StoreDbContext db, DemoNotificationQueue notifications, SendproofPreview preview)
    {
        var errors = EndpointSupport.Validate(request);
        var currency = EndpointSupport.ParseCurrency(request.PreferredCurrency);
        if (currency is null) errors["preferredCurrency"] = [$"Use one of: {EndpointSupport.CurrencyNames}."];
        if (errors.Count > 0) return Results.ValidationProblem(errors);
        var email = request.Email.Trim().ToLowerInvariant();
        if (await db.Customers.AnyAsync(c => c.Email == email)) return EndpointSupport.Conflict($"A customer with the email address {email} already exists.");
        var customer = new CustomerRecord
        {
            Id = Guid.NewGuid(), Email = email, FirstName = request.FirstName.Trim(), LastName = request.LastName.Trim(), Phone = request.Phone,
            PreferredCurrency = currency!.Value, Tier = CustomerTier.Standard, MarketingOptIn = request.MarketingOptIn, CreatedAt = DateTimeOffset.UtcNow
        };
        db.Customers.Add(customer);
        db.Audit("Customer", customer.Id, "Customer.Registered", email);
        await db.SaveChangesAsync();
        notifications.CustomerRegistered(customer, preview);
        return TypedResults.Created($"/api/v2/customers/{customer.Id}", await customer.ToContractAsync(db));
    }

    /// <summary>Update customer</summary>
    /// <remarks>Replaces a customer's name, phone, currency and marketing choice. The email address and tier cannot change here. Customers can update only themselves.</remarks>
    /// <param name="id">The customer's ID.</param>
    /// <param name="request">The new values. Every field is replaced.</param>
    /// <response code="200">The updated customer.</response>
    /// <response code="400">A field was invalid.</response>
    /// <response code="403">You are a customer and this is somebody else's profile.</response>
    /// <response code="404">No customer has this ID.</response>
    internal static async Task<IResult> Update(Guid id, UpdateCustomerRequest request, StoreDbContext db, ClaimsPrincipal principal)
    {
        var customer = await db.Customers.SingleOrDefaultAsync(c => c.Id == id);
        if (customer is null) return EndpointSupport.NotFound("customer", id);
        if (!principal.CanActFor(customer)) return EndpointSupport.Forbidden(EndpointSupport.NotYours);
        var errors = EndpointSupport.Validate(request);
        var currency = EndpointSupport.ParseCurrency(request.PreferredCurrency);
        if (currency is null) errors["preferredCurrency"] = [$"Use one of: {EndpointSupport.CurrencyNames}."];
        if (errors.Count > 0) return Results.ValidationProblem(errors);
        customer.FirstName = request.FirstName.Trim();
        customer.LastName = request.LastName.Trim();
        customer.Phone = request.Phone;
        customer.PreferredCurrency = currency!.Value;
        customer.MarketingOptIn = request.MarketingOptIn;
        db.Audit("Customer", customer.Id, "Customer.Updated", principal.Email());
        await db.SaveChangesAsync();
        return TypedResults.Ok(await customer.ToContractAsync(db));
    }

    /// <summary>List customer addresses</summary>
    /// <remarks>Returns the shipping and billing addresses saved on a customer, defaults first.</remarks>
    /// <param name="id">The customer's ID.</param>
    /// <response code="200">The addresses.</response>
    /// <response code="403">You are a customer and this is somebody else's profile.</response>
    /// <response code="404">No customer has this ID.</response>
    internal static async Task<IResult> Addresses(Guid id, StoreDbContext db, ClaimsPrincipal principal)
    {
        var customer = await db.Customers.AsNoTracking().SingleOrDefaultAsync(c => c.Id == id);
        if (customer is null) return EndpointSupport.NotFound("customer", id);
        if (!principal.CanActFor(customer)) return EndpointSupport.Forbidden(EndpointSupport.NotYours);
        var rows = await db.Addresses.AsNoTracking().Where(a => a.CustomerId == id).ToListAsync();
        return TypedResults.Ok<IReadOnlyList<CustomerAddress>>(rows.OrderByDescending(a => a.IsDefault).ThenBy(a => a.Kind).ThenBy(a => a.Label).Select(a => a.ToContract()).ToList());
    }

    /// <summary>Add customer address</summary>
    /// <remarks>
    /// Saves an address on a customer. Set `makeDefault` to make it the default of its kind (the previous default stops being one).
    /// A customer can have at most ten addresses.
    /// </remarks>
    /// <param name="id">The customer's ID.</param>
    /// <param name="request">The address to save.</param>
    /// <response code="201">The address was saved.</response>
    /// <response code="400">A field was missing or invalid. Nested fields are named like `address.city`.</response>
    /// <response code="403">You are a customer and this is somebody else's profile.</response>
    /// <response code="404">No customer has this ID.</response>
    internal static async Task<IResult> AddAddress(Guid id, AddAddressRequest request, StoreDbContext db, ClaimsPrincipal principal)
    {
        var customer = await db.Customers.AsNoTracking().SingleOrDefaultAsync(c => c.Id == id);
        if (customer is null) return EndpointSupport.NotFound("customer", id);
        if (!principal.CanActFor(customer)) return EndpointSupport.Forbidden(EndpointSupport.NotYours);
        var errors = EndpointSupport.Validate(request);
        if (!Enum.TryParse<AddressKind>(request.Kind, false, out var kind) || !Enum.IsDefined(kind)) errors["kind"] = ["Use Shipping or Billing."];
        if (errors.Count > 0) return Results.ValidationProblem(errors);
        var existing = await db.Addresses.Where(a => a.CustomerId == id).ToListAsync();
        if (existing.Count >= 10) return Results.ValidationProblem(new Dictionary<string, string[]> { ["address"] = ["A customer can save at most ten addresses."] });
        var makeDefault = request.MakeDefault || !existing.Any(a => a.Kind == kind);
        if (makeDefault) foreach (var other in existing.Where(a => a.Kind == kind)) other.IsDefault = false;
        var address = new AddressRecord
        {
            Id = Guid.NewGuid(), CustomerId = id, Kind = kind, Label = request.Label, IsDefault = makeDefault, Recipient = request.Address.Recipient,
            Line1 = request.Address.Line1, Line2 = request.Address.Line2, City = request.Address.City, Region = request.Address.Region,
            PostalCode = request.Address.PostalCode, Country = request.Address.Country
        };
        db.Addresses.Add(address);
        db.Audit("Customer", id, $"Customer.AddressAdded: {request.Label}", principal.Email());
        await db.SaveChangesAsync();
        return TypedResults.Created($"/api/v2/customers/{id}/addresses", address.ToContract());
    }
}
