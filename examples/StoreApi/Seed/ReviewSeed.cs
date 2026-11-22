using MongoDB.Bson;

namespace StoreApi;

/// <summary>
/// Seeds product reviews. Each product's reviews are derived from its slug alone, so the SQL product rows (average and
/// count) and the MongoDB <c>product_reviews</c> documents agree without sharing state.
/// </summary>
internal static class ReviewSeed
{
    private static readonly string[] Praise =
    [
        "Does exactly what it says. I have used it on {0} trips since the spring and it still looks new.",
        "Bought this after my old one wore out. Better made, lighter, and the fit is spot on.",
        "Excellent quality for the price. Delivery to my door took two days.",
        "Used it all through a wet week in the hills and it never let me down. Highly recommended.",
        "Comfortable from the first wear. My only wish is that I had bought it years ago.",
        "Great value. The details, like the zips and the stitching, are what you expect from a much dearer brand."
    ];

    private static readonly string[] Mixed =
    [
        "Good product, though the sizing runs a little small. Order one up if you are between sizes.",
        "Works well, but it took two weeks to arrive and the box was damaged.",
        "Solid and well made. I would give five stars if it came in more colours."
    ];

    private static readonly string[] Poor =
    [
        "The first one I received had a faulty seam. Support replaced it quickly, but it was a hassle.",
        "Not as described: it is noticeably heavier than the listing says."
    ];

    private static readonly string[] PraiseTitles = ["Love it", "Worth every penny", "Exactly what I needed", "Great quality", "Brilliant", "Highly recommend"];
    private static readonly string[] MixedTitles = ["Good, with a caveat", "Mostly happy", "Decent"];
    private static readonly string[] PoorTitles = ["Disappointed", "Not as described"];
    private static readonly string[] Names = ["Aoife M.", "Daniel K.", "Sofia R.", "Henrik L.", "Priya S.", "Tom B.", "Camille D.", "Yuki T.", "Hannah W.", "Marcus O.", "Ines C.", "Callum F.", "Zoe P.", "Jonas H."];

    /// <summary>The average rating and review count a product's seeded reviews add up to.</summary>
    internal static (double Average, int Count) Summary(string slug)
    {
        var ratings = Ratings(slug);
        return ratings.Count == 0 ? (0, 0) : (Math.Round(ratings.Average(), 1), ratings.Count);
    }

    /// <summary>A hash of the slug that is the same on every run (string.GetHashCode is randomised per process).</summary>
    private static int Hash(string slug) => slug.Aggregate(17, (hash, c) => unchecked(hash * 31 + c));

    private static Random For(string slug) => new(Hash(slug));

    private static List<int> Ratings(string slug)
    {
        var rng = For(slug);
        if (rng.Chance(0.12)) return [];
        var count = rng.Between(3, 11);
        return Enumerable.Range(0, count).Select(_ => rng.NextDouble() switch { < 0.55 => 5, < 0.82 => 4, < 0.92 => 3, < 0.97 => 2, _ => 1 }).ToList();
    }

    /// <summary>Builds one <c>product_reviews</c> document per reviewed product: the average, count, star distribution and the nested reviews.</summary>
    internal static IEnumerable<BsonDocument> Create(IEnumerable<ProductRecord> products)
    {
        var now = DateTime.UtcNow;
        foreach (var product in products)
        {
            var ratings = Ratings(product.Slug);
            if (ratings.Count == 0 || product.Status == ProductStatus.Draft) continue;
            var rng = For(product.Slug + "#text");
            var reviews = new BsonArray();
            for (var i = 0; i < ratings.Count; i++)
            {
                var rating = ratings[i];
                var (title, body) = rating switch
                {
                    >= 4 => (rng.Pick(PraiseTitles), string.Format(rng.Pick(Praise), rng.Between(3, 14))),
                    3 => (rng.Pick(MixedTitles), rng.Pick(Mixed)),
                    _ => (rng.Pick(PoorTitles), rng.Pick(Poor))
                };
                var review = new BsonDocument
                {
                    { "_id", $"rv_{Hash(product.Slug) & 0xFFFF:x4}{i:x2}" }, { "customerId", $"seed-{i}" }, { "rating", rating }, { "title", title }, { "body", body },
                    { "author", new BsonDocument { { "name", rng.Pick(Names) }, { "verifiedPurchase", rng.Chance(0.8) } } },
                    { "helpfulVotes", rng.Between(0, rating >= 4 ? 18 : 6) }, { "createdAt", now.AddDays(-rng.Between(2, 400)) }
                };
                if (rating <= 2 || rng.Chance(0.12))
                    review["reply"] = new BsonDocument
                    {
                        { "by", "Acme Store Support" }, { "text", rating <= 2 ? "Sorry about that. Please contact support@acme-store.example with your order number and we will put it right." : "Thank you for the kind words!" },
                        { "at", now.AddDays(-rng.Between(1, 20)) }
                    };
                reviews.Add(review);
            }
            // Newest first, as the API lists them.
            var sorted = new BsonArray(reviews.Cast<BsonDocument>().OrderByDescending(r => r["createdAt"].ToUniversalTime()));
            yield return new BsonDocument
            {
                { "_id", product.Id.ToString() }, { "average", Math.Round(ratings.Average(), 1) }, { "count", ratings.Count },
                { "distribution", new BsonArray(Enumerable.Range(1, 5).Reverse().Select(stars => new BsonDocument { { "stars", stars }, { "count", ratings.Count(r => r == stars) } })) },
                { "reviews", sorted }
            };
        }
    }
}
