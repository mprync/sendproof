using System.Security.Claims;
using Microsoft.EntityFrameworkCore;
using MongoDB.Bson;
using Sendproof.AspNetCore;

namespace StoreApi;

/// <summary>
/// The review operations: list a product's reviews, add one and vote on one. Reviews are nested documents in MongoDB
/// (one <c>product_reviews</c> document per product), so these operations exist only when the demo has that store.
/// </summary>
internal static class ReviewEndpoints
{
    internal static void MapReviewEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/v2/products/{productId:guid}/reviews").WithTags("Reviews");
        group.MapGet("/", List).WithName("ReviewsController.List").Produces<ReviewPage>().ProducesProblem(StatusCodes.Status404NotFound);
        group.MapPost("/", Add).WithName("ReviewsController.Add").RequireAuthorization(Policies.Shoppers)
            .Produces<Review>(StatusCodes.Status201Created).ProducesValidationProblem().ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status404NotFound).ProducesProblem(StatusCodes.Status409Conflict).WithSendproofPreview();
        group.MapPost("/{reviewId}/votes", Vote).WithName("ReviewsController.Vote").RequireAuthorization()
            .Produces(StatusCodes.Status204NoContent).ProducesProblem(StatusCodes.Status404NotFound).WithSendproofPreview();
    }

    /// <summary>List product reviews</summary>
    /// <remarks>
    /// Returns a product's reviews, newest first, with the average, the count and how the ratings spread. **Public.** Each review has a nested `author`
    /// (with whether they bought the product) and, when staff answered, a nested `reply`. The whole product is one document in MongoDB, so this is a single read.
    /// </remarks>
    /// <param name="productId">The product's ID, from `ProductsController.List`.</param>
    /// <param name="minRating">Only reviews with at least this many stars.</param>
    /// <response code="200">The reviews. A product nobody reviewed yet returns an empty list.</response>
    /// <response code="404">No product has this ID.</response>
    internal static async Task<IResult> List(Guid productId, StoreDbContext db, DemoStores stores, int minRating = 1)
    {
        if (!await db.Products.AnyAsync(p => p.Id == productId)) return EndpointSupport.NotFound("product", productId);
        var document = await stores.ReviewsAsync(productId);
        var reviews = document?["reviews"].AsBsonArray.Select(r => r.AsBsonDocument).Where(r => r["rating"].ToInt32() >= minRating).Select(ToReview).ToList() ?? [];
        return TypedResults.Ok(new ReviewPage
        {
            ProductId = productId, Average = document?["average"].ToDouble() ?? 0, Count = document?["count"].ToInt32() ?? 0,
            Distribution = document?["distribution"].AsBsonArray.Select(d => new RatingBucket { Stars = d["stars"].ToInt32(), Count = d["count"].ToInt32() }).ToList()
                ?? Enumerable.Range(1, 5).Reverse().Select(s => new RatingBucket { Stars = s, Count = 0 }).ToList(),
            Reviews = reviews
        });
    }

    /// <summary>Add review</summary>
    /// <remarks>
    /// Adds a review to a product. The review is pushed onto the product's MongoDB document, the average and star counts are recomputed there, and the
    /// product's `rating` and `reviewCount` are updated in SQL, so Preview shows both stores changing. The author is marked as a **verified purchase**
    /// when they have a delivered order with this product. A customer can review a product only once (409 otherwise).
    /// </remarks>
    /// <param name="productId">The product's ID.</param>
    /// <param name="request">The review to add.</param>
    /// <response code="201">The review was added.</response>
    /// <response code="400">A field was missing or invalid.</response>
    /// <response code="403">You are a customer and tried to review as somebody else.</response>
    /// <response code="404">No product or customer has this ID.</response>
    /// <response code="409">This customer already reviewed this product.</response>
    internal static async Task<IResult> Add(Guid productId, AddReviewRequest request, StoreDbContext db, ClaimsPrincipal principal,
        DemoStores stores, DemoNotificationQueue notifications, SendproofPreview preview)
    {
        var product = await db.Products.SingleOrDefaultAsync(p => p.Id == productId);
        if (product is null) return EndpointSupport.NotFound("product", productId);
        var errors = EndpointSupport.Validate(request);
        var customer = await db.Customers.AsNoTracking().SingleOrDefaultAsync(c => c.Id == request.CustomerId);
        if (customer is null) errors["customerId"] = ["Choose an existing customer."];
        if (errors.Count > 0) return Results.ValidationProblem(errors);
        if (!principal.CanActFor(customer!)) return EndpointSupport.Forbidden("Customers can only review as themselves.");

        var existing = await stores.ReviewsAsync(productId);
        var authorKey = $"{customer!.Id}";
        if (existing?["reviews"].AsBsonArray.Any(r => r.AsBsonDocument.TryGetValue("customerId", out var id) && id.AsString == authorKey) == true)
            return EndpointSupport.Conflict("This customer already reviewed this product.");
        var verified = await (from l in db.OrderLines.AsNoTracking() join v in db.Variants.AsNoTracking() on l.VariantId equals v.Id
                              join o in db.Orders.AsNoTracking() on l.OrderId equals o.Id
                              where v.ProductId == productId && o.CustomerId == customer.Id && o.Status == OrderStatus.Delivered select l.Id).AnyAsync();
        var now = DateTimeOffset.UtcNow;
        var review = new BsonDocument
        {
            { "_id", $"rv_{Guid.NewGuid():N}"[..15] }, { "customerId", authorKey }, { "rating", request.Rating }, { "title", request.Title }, { "body", request.Body },
            { "author", new BsonDocument { { "name", $"{customer.FirstName} {customer.LastName[0]}." }, { "verifiedPurchase", verified } } },
            { "helpfulVotes", 0 }, { "createdAt", now.UtcDateTime }
        };
        var (average, count) = await stores.AddReviewAsync(productId, review);
        product.RatingAverage = average;
        product.ReviewCount = count;
        product.UpdatedAt = now;
        db.Audit("Product", productId, $"Review.Added: {request.Rating} stars", principal.Email());
        await db.SaveChangesAsync();
        notifications.ReviewAdded(product, request.Rating, preview);
        return TypedResults.Created($"/api/v2/products/{productId}/reviews", ToReview(review));
    }

    /// <summary>Vote on review</summary>
    /// <remarks>Counts one helpful vote on a review, incrementing its `helpfulVotes` in the product's MongoDB document. A vote that is not helpful changes nothing.</remarks>
    /// <param name="productId">The product's ID.</param>
    /// <param name="reviewId">The review's ID, from `ReviewsController.List`.</param>
    /// <param name="request">The vote.</param>
    /// <response code="204">The vote was recorded.</response>
    /// <response code="404">No such product or review.</response>
    internal static async Task<IResult> Vote(Guid productId, string reviewId, ReviewVoteRequest request, StoreDbContext db, DemoStores stores)
    {
        if (!await db.Products.AnyAsync(p => p.Id == productId)) return EndpointSupport.NotFound("product", productId);
        if (!request.Helpful) return Results.NoContent();
        return await stores.VoteReviewAsync(productId, reviewId) ? Results.NoContent() : EndpointSupport.NotFound("review", reviewId);
    }

    private static Review ToReview(BsonDocument r) => new()
    {
        Id = r["_id"].AsString, Rating = r["rating"].ToInt32(), Title = r["title"].AsString, Body = r["body"].AsString,
        Author = new ReviewAuthor { Name = r["author"]["name"].AsString, VerifiedPurchase = r["author"]["verifiedPurchase"].AsBoolean },
        HelpfulVotes = r["helpfulVotes"].ToInt32(),
        Reply = r.TryGetValue("reply", out var reply) && reply.IsBsonDocument
            ? new ReviewReply { By = reply["by"].AsString, Text = reply["text"].AsString, At = new DateTimeOffset(reply["at"].ToUniversalTime()) } : null,
        CreatedAt = new DateTimeOffset(r["createdAt"].ToUniversalTime())
    };
}
