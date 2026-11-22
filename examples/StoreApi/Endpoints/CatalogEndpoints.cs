using System.Security.Claims;
using Microsoft.EntityFrameworkCore;
using Sendproof.AspNetCore;

namespace StoreApi;

/// <summary>The catalogue operations: browse and search products, read one, create and change products, and list and create categories.</summary>
internal static class CatalogEndpoints
{
    /// <summary>How the retired v1 search is replaced; read by the OpenAPI document and the response headers.</summary>
    private static readonly DeprecationMetadata LegacySearchRetirement = new(
        [new("ProductsController.List", "Search, filter, sort and page the same catalogue, in any currency.", new Dictionary<string, string> { ["q"] = "$request.query.term" })],
        new DateOnly(2027, 3, 31));

    internal static void MapCatalogEndpoints(this IEndpointRouteBuilder app)
    {
        var products = app.MapGroup("/api/v2/products").WithTags("Catalog");
        // The catalogue is public: shoppers browse before they sign in.
        products.MapGet("/", List).WithName("ProductsController.List")
            .WithMetadata(new SortKeysMetadata(SortKeys.Products, SortKeys.ProductDescriptions))
            .Produces<PagedList<ProductSummary>>().ProducesValidationProblem();
        products.MapGet("/{id:guid}", Get).WithName("ProductsController.Get")
            .Produces<Product>().ProducesProblem(StatusCodes.Status404NotFound);
        products.MapPost("/", Create).WithName("ProductsController.Create").RequireAuthorization(Policies.Admins)
            .Produces<Product>(StatusCodes.Status201Created).ProducesValidationProblem().ProducesProblem(StatusCodes.Status409Conflict)
            .WithSendproofPreview();
        products.MapPut("/{id:guid}", Update).WithName("ProductsController.Update").RequireAuthorization(Policies.Admins)
            .Produces<Product>().ProducesValidationProblem().ProducesProblem(StatusCodes.Status404NotFound).WithSendproofPreview();
        app.MapGet("/api/v1/products/search", LegacySearch).WithTags("Catalog").WithName("ProductsController.LegacySearch")
            .WithMetadata(new ObsoleteAttribute("Use GET /api/v2/products?q=."), LegacySearchRetirement)
            .Produces<IReadOnlyList<LegacyProductHit>>().ProducesValidationProblem();

        var categories = app.MapGroup("/api/v2/categories").WithTags("Catalog");
        categories.MapGet("/", ListCategories).WithName("CategoriesController.List").Produces<IReadOnlyList<Category>>();
        categories.MapPost("/", CreateCategory).WithName("CategoriesController.Create").RequireAuthorization(Policies.Admins)
            .Produces<Category>(StatusCodes.Status201Created).ProducesValidationProblem().ProducesProblem(StatusCodes.Status409Conflict)
            .WithSendproofPreview();
    }

    /// <summary>List products</summary>
    /// <remarks>
    /// Browses the catalogue. This operation is **public**: you do not need to sign in. Shoppers only see `Active`
    /// products; staff can also see `Draft` and `Archived` ones with `status`.
    ///
    /// - Prices are shown in `currency` (default `USD`). Every product has a price in all eight currencies.
    /// - `q` searches the name, brand and tags; `minPrice` and `maxPrice` apply to the lowest variant price.
    /// - Sort by `price`, `rating` or `createdAt`; a leading `-` reverses the order, as in `-price`.
    ///
    /// Open a product with `ProductsController.Get` to see its variants.
    /// </remarks>
    /// <param name="page">The 1-based page number.</param>
    /// <param name="pageSize">How many products to return per page, from 1 to 100.</param>
    /// <param name="q">Search text matched against name, brand and tags.</param>
    /// <param name="categoryId">Only products in this category.</param>
    /// <param name="brand">Only products by this brand, spelled exactly.</param>
    /// <param name="tag">Only products with this tag, such as `waterproof`.</param>
    /// <param name="status">Only products with this status. Shoppers always get `Active`.</param>
    /// <param name="currency">The currency to show prices in. Defaults to `USD`.</param>
    /// <param name="minPrice">Only products whose lowest price is at least this, in `currency`.</param>
    /// <param name="maxPrice">Only products whose lowest price is at most this, in `currency`.</param>
    /// <param name="inStock">Only products that have (`true`) or lack (`false`) stock.</param>
    /// <param name="sort">The sort order: a field name, with a leading minus for descending. Defaults to `-createdAt`.</param>
    /// <response code="200">A page of products.</response>
    /// <response code="400">A paging, sort or filter value was invalid.</response>
    internal static async Task<IResult> List(StoreDbContext db, ClaimsPrincipal principal, int page = 1, int pageSize = EndpointSupport.DefaultPageSize,
        string? q = null, Guid? categoryId = null, string? brand = null, string? tag = null, ProductStatus? status = null,
        Currency currency = Currency.USD, decimal? minPrice = null, decimal? maxPrice = null, bool? inStock = null, string? sort = null)
    {
        var errors = new Dictionary<string, string[]>();
        EndpointSupport.CheckPaging(page, pageSize, errors);
        EndpointSupport.CheckSort(sort, SortKeys.Products, errors);
        if (minPrice is { } lo && maxPrice is { } hi && hi < lo) errors["maxPrice"] = ["maxPrice must not be below minPrice."];
        if (errors.Count > 0) return Results.ValidationProblem(errors);

        // Shoppers (and anonymous callers) only ever see products on sale.
        var visible = principal.Identity?.IsAuthenticated == true && principal.IsStaff() ? status : ProductStatus.Active;
        var query = db.Products.AsNoTracking().AsQueryable();
        if (visible is { } s) query = query.Where(p => p.Status == s);
        if (categoryId is { } c) query = query.Where(p => p.CategoryId == c);
        if (!string.IsNullOrWhiteSpace(brand)) query = query.Where(p => p.Brand == brand);
        if (!string.IsNullOrWhiteSpace(tag)) query = query.Where(p => EF.Functions.Like(p.Tags!, "%" + tag.Trim() + "%"));
        if (!string.IsNullOrWhiteSpace(q))
        {
            var pattern = EndpointSupport.LikePattern(q);
            query = query.Where(p => EF.Functions.Like(p.Name, pattern, "\\") || EF.Functions.Like(p.Brand, pattern, "\\") || EF.Functions.Like(p.Tags!, pattern, "\\"));
        }
        if (inStock is { } wanted)
            query = query.Where(p => db.Variants.Any(v => v.ProductId == p.Id && db.Stock.Any(st => st.VariantId == v.Id && st.OnHand - st.Reserved > 0)) == wanted);

        // Price filters and the price sort work on the cheapest variant in the requested currency.
        var needsPrice = minPrice is not null || maxPrice is not null || sort is "price" or "-price";
        if (!needsPrice)
        {
            var ordered = (sort ?? "-createdAt") switch
            {
                "name" => EndpointSupport.Sorted(query, false, p => p.Name, p => p.Id),
                "-name" => EndpointSupport.Sorted(query, true, p => p.Name, p => p.Id),
                "rating" => EndpointSupport.Sorted(query, false, p => p.RatingAverage, p => p.Id),
                "-rating" => EndpointSupport.Sorted(query, true, p => p.RatingAverage, p => p.Id),
                "createdAt" => EndpointSupport.Sorted(query, false, p => p.CreatedAt, p => p.Id),
                _ => EndpointSupport.Sorted(query, true, p => p.CreatedAt, p => p.Id)
            };
            return TypedResults.Ok(await EndpointSupport.PageAsync(ordered, page, pageSize, async rows => await rows.ToSummariesAsync(db, currency)));
        }

        var all = await query.ToListAsync();
        var summaries = (await all.ToSummariesAsync(db, currency)).Where(p =>
            (minPrice is null || p.Price.Value >= minPrice) && (maxPrice is null || p.Price.Value <= maxPrice));
        var sorted = (sort == "-price" ? summaries.OrderByDescending(p => p.Price.Value) : summaries.OrderBy(p => p.Price.Value)).ThenBy(p => p.Id).ToList();
        return TypedResults.Ok(new PagedList<ProductSummary>
        {
            Items = sorted.Skip((page - 1) * pageSize).Take(pageSize).ToList(), Page = page, PageSize = pageSize,
            TotalItems = sorted.Count, TotalPages = (int)Math.Ceiling(sorted.Count / (double)pageSize)
        });
    }

    /// <summary>Get product</summary>
    /// <remarks>
    /// Returns one product with its description, dimensions and every variant. **Public.** Each variant carries its SKU, its price in
    /// all eight currencies and how many units can be bought now (`available`). Use a SKU with `CartsController.AddItem` or
    /// `OrdersController.Place`.
    /// </remarks>
    /// <param name="id">The product's ID, from `ProductsController.List`.</param>
    /// <response code="200">The product.</response>
    /// <response code="404">No product has this ID, or it is not on sale and you are not staff.</response>
    internal static async Task<IResult> Get(Guid id, StoreDbContext db, ClaimsPrincipal principal)
    {
        var product = await db.Products.AsNoTracking().SingleOrDefaultAsync(p => p.Id == id);
        var hidden = product is not null && product.Status != ProductStatus.Active && !(principal.Identity?.IsAuthenticated == true && principal.IsStaff());
        return product is null || hidden ? EndpointSupport.NotFound("product", id) : TypedResults.Ok(await product.ToContractAsync(db));
    }

    /// <summary>Create product</summary>
    /// <remarks>
    /// Adds a product and its variants to the catalogue, with a `Draft` status until you publish it with `ProductsController.Update`.
    /// You give one **base price** (`price` in `currency`); the price in every other currency is derived from it.
    /// Each variant gets a stock record in the `DUB-01` warehouse with its `initialStock`.
    ///
    /// Preview shows the rows added to every table, the search-index message and the SQL, without keeping any of it. Requires the `admin` role.
    /// </remarks>
    /// <param name="request">The product to create.</param>
    /// <response code="201">The product was created. The `Location` header points to it.</response>
    /// <response code="400">A field was missing or invalid. The `errors` object names each one.</response>
    /// <response code="409">The slug or a SKU is already used by another product.</response>
    internal static async Task<IResult> Create(CreateProductRequest request, StoreDbContext db, ClaimsPrincipal principal,
        DemoNotificationQueue notifications, SendproofPreview preview)
    {
        var errors = EndpointSupport.Validate(request);
        var currency = EndpointSupport.ParseCurrency(request.Currency);
        if (currency is null) errors["currency"] = [$"Use one of: {EndpointSupport.CurrencyNames}."];
        else if (request.Price < 0.01m) errors["price"] = ["Price must be at least 0.01."];
        else if (EndpointSupport.HasTooManyDecimals(request.Price, currency.Value))
            errors["price"] = [$"{currency} prices allow at most {EndpointSupport.Decimals(currency.Value)} decimal places."];
        var category = await db.Categories.AsNoTracking().SingleOrDefaultAsync(c => c.Id == request.CategoryId);
        if (category is null) errors["categoryId"] = ["Choose an existing category."];
        for (var i = 0; i < request.Variants.Length; i++)
            if (request.Variants.Count(v => v.Sku == request.Variants[i].Sku) > 1) errors[$"variants[{i}].sku"] = ["SKUs must be unique within the product."];
        if (errors.Count > 0) return Results.ValidationProblem(errors);

        if (await db.Products.AnyAsync(p => p.Slug == request.Slug))
            return EndpointSupport.Conflict($"The slug '{request.Slug}' is already used by another product.");
        var skus = request.Variants.Select(v => v.Sku).ToList();
        if (await db.Variants.AnyAsync(v => skus.Contains(v.Sku)))
            return EndpointSupport.Conflict("One of the SKUs already belongs to another product.");

        var now = DateTimeOffset.UtcNow;
        var baseUsd = request.Price / Pricing.Rate(currency!.Value);
        var product = new ProductRecord
        {
            Id = Guid.NewGuid(), Slug = request.Slug, Name = request.Name, Brand = request.Brand, Description = request.Description,
            CategoryId = request.CategoryId, Status = ProductStatus.Draft, Tags = request.Tags is null ? null : string.Join(',', request.Tags),
            WeightGrams = request.WeightGrams, WidthCm = request.Dimensions?.WidthCm ?? 0, HeightCm = request.Dimensions?.HeightCm ?? 0,
            DepthCm = request.Dimensions?.DepthCm ?? 0, CreatedAt = now, UpdatedAt = now
        };
        db.Products.Add(product);
        foreach (var requested in request.Variants)
        {
            var variant = new VariantRecord
            {
                Id = Guid.NewGuid(), ProductId = product.Id, Sku = requested.Sku, Color = requested.Color, Size = requested.Size,
                Name = string.Join(" / ", new[] { requested.Color, requested.Size }.Where(x => !string.IsNullOrEmpty(x)).DefaultIfEmpty("Standard"))
            };
            db.Variants.Add(variant);
            foreach (var each in Enum.GetValues<Currency>())
                db.Prices.Add(new PriceRecord
                {
                    Id = Guid.NewGuid(), VariantId = variant.Id, Currency = each,
                    Amount = each == currency ? request.Price : Pricing.Convert(baseUsd, each)
                });
            db.Stock.Add(new StockRecord { Id = Guid.NewGuid(), VariantId = variant.Id, Warehouse = "DUB-01", OnHand = requested.InitialStock, ReorderPoint = 10, UpdatedAt = now });
        }
        db.Audit("Product", product.Id, "Product.Created", principal.Email());
        await db.SaveChangesAsync();
        notifications.ProductCreated(product, preview);
        return TypedResults.Created($"/api/v2/products/{product.Id}", await product.ToContractAsync(db));
    }

    /// <summary>Update product</summary>
    /// <remarks>
    /// Replaces a product's name, description, category, tags and status. Use it to publish a `Draft` (set `status` to `Active`) or to
    /// withdraw a product (`Archived`; past orders keep it). SKUs, prices and stock have their own operations. Requires the `admin` role.
    /// </remarks>
    /// <param name="id">The product's ID.</param>
    /// <param name="request">The new values. Every field is replaced.</param>
    /// <response code="200">The updated product.</response>
    /// <response code="400">A field was invalid.</response>
    /// <response code="404">No product has this ID.</response>
    internal static async Task<IResult> Update(Guid id, UpdateProductRequest request, StoreDbContext db, ClaimsPrincipal principal)
    {
        var product = await db.Products.SingleOrDefaultAsync(p => p.Id == id);
        if (product is null) return EndpointSupport.NotFound("product", id);
        var errors = EndpointSupport.Validate(request);
        if (!Enum.TryParse<ProductStatus>(request.Status, false, out var status) || !Enum.IsDefined(status))
            errors["status"] = ["Use Draft, Active or Archived."];
        if (!await db.Categories.AnyAsync(c => c.Id == request.CategoryId)) errors["categoryId"] = ["Choose an existing category."];
        if (errors.Count > 0) return Results.ValidationProblem(errors);

        product.Name = request.Name;
        product.Description = request.Description;
        product.CategoryId = request.CategoryId;
        product.Status = status;
        product.Tags = request.Tags is null ? null : string.Join(',', request.Tags);
        product.UpdatedAt = DateTimeOffset.UtcNow;
        db.Audit("Product", product.Id, $"Product.Updated: {status}", principal.Email());
        await db.SaveChangesAsync();
        return TypedResults.Ok(await product.ToContractAsync(db));
    }

    /// <summary>Search products (v1)</summary>
    /// <remarks>
    /// **Deprecated.** The v1 search returns only a name and a US-dollar price. Use `ProductsController.List`, which takes the same text as
    /// `q` and adds filters, sorting, paging and every currency. The response carries a `Deprecation` header, a `Sunset` header with
    /// the removal date and a `Link` to its replacement.
    /// </remarks>
    /// <param name="term">The text to search for in names and brands.</param>
    /// <param name="context">The current HTTP context, used to add the deprecation headers.</param>
    /// <response code="200">Up to 20 matching products.</response>
    /// <response code="400">The search term was missing.</response>
    internal static async Task<IResult> LegacySearch(StoreDbContext db, HttpContext context, string? term = null)
    {
        if (string.IsNullOrWhiteSpace(term)) return Results.ValidationProblem(new Dictionary<string, string[]> { ["term"] = ["Say what to search for."] });
        context.Response.Headers["Deprecation"] = "true";
        context.Response.Headers["Sunset"] = LegacySearchRetirement.SunsetHttpDate;
        context.Response.Headers.Link = $"</api/v2/products?q={Uri.EscapeDataString(term)}>; rel=\"successor-version\"";
        var pattern = EndpointSupport.LikePattern(term);
        var hits = await db.Products.AsNoTracking().Where(p => p.Status == ProductStatus.Active &&
            (EF.Functions.Like(p.Name, pattern, "\\") || EF.Functions.Like(p.Brand, pattern, "\\"))).OrderBy(p => p.Name).Take(20).ToListAsync();
        var summaries = await hits.ToSummariesAsync(db, Currency.USD);
        return TypedResults.Ok<IReadOnlyList<LegacyProductHit>>(summaries.Select(s => new LegacyProductHit { Id = s.Id, Name = s.Name, Price = s.Price.Value }).ToList());
    }

    /// <summary>List categories</summary>
    /// <remarks>Returns every category with the number of active products in it, parents before children. **Public.** Use a category's ID as `categoryId` in `ProductsController.List`.</remarks>
    /// <response code="200">The categories.</response>
    internal static async Task<IResult> ListCategories(StoreDbContext db)
    {
        var counts = await db.Products.AsNoTracking().Where(p => p.Status == ProductStatus.Active).GroupBy(p => p.CategoryId)
            .Select(g => new { g.Key, Count = g.Count() }).ToDictionaryAsync(g => g.Key, g => g.Count);
        var rows = await db.Categories.AsNoTracking().OrderBy(c => c.Name).ToListAsync();
        return TypedResults.Ok<IReadOnlyList<Category>>(rows.OrderBy(c => c.ParentId.HasValue).ThenBy(c => c.Name).Select(c => new Category
        {
            Id = c.Id, Slug = c.Slug, Name = c.Name, Description = c.Description, ParentId = c.ParentId, ProductCount = counts.GetValueOrDefault(c.Id)
        }).ToList());
    }

    /// <summary>Create category</summary>
    /// <remarks>Adds a category, optionally under a parent from `CategoriesController.List`. Requires the `admin` role.</remarks>
    /// <param name="request">The category to create.</param>
    /// <response code="201">The category was created.</response>
    /// <response code="400">A field was missing or invalid.</response>
    /// <response code="409">The slug is already used by another category.</response>
    internal static async Task<IResult> CreateCategory(CreateCategoryRequest request, StoreDbContext db, ClaimsPrincipal principal)
    {
        var errors = EndpointSupport.Validate(request);
        if (request.ParentId is { } parent && !await db.Categories.AnyAsync(c => c.Id == parent)) errors["parentId"] = ["Choose an existing parent category."];
        if (errors.Count > 0) return Results.ValidationProblem(errors);
        if (await db.Categories.AnyAsync(c => c.Slug == request.Slug)) return EndpointSupport.Conflict($"The slug '{request.Slug}' is already used by another category.");
        var category = new CategoryRecord { Id = Guid.NewGuid(), Slug = request.Slug, Name = request.Name, Description = request.Description, ParentId = request.ParentId };
        db.Categories.Add(category);
        db.Audit("Category", category.Id, "Category.Created", principal.Email());
        await db.SaveChangesAsync();
        return TypedResults.Created($"/api/v2/categories/{category.Id}", new Category
        {
            Id = category.Id, Slug = category.Slug, Name = category.Name, Description = category.Description, ParentId = category.ParentId, ProductCount = 0
        });
    }
}
