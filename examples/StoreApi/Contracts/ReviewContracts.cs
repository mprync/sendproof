using System.ComponentModel.DataAnnotations;

namespace StoreApi;

/// <summary>Who wrote a review.</summary>
public sealed class ReviewAuthor
{
    /// <summary>The name shown with the review, such as <c>Mia C.</c>.</summary>
    public required string Name { get; init; }
    /// <summary>Whether the author bought the product from the store.</summary>
    public required bool VerifiedPurchase { get; init; }
}

/// <summary>The store's answer to a review.</summary>
public sealed class ReviewReply
{
    /// <summary>Who answered.</summary>
    public required string By { get; init; }
    /// <summary>The answer.</summary>
    public required string Text { get; init; }
    /// <summary>When it was written.</summary>
    public required DateTimeOffset At { get; init; }
}

/// <summary>A shopper's review of a product, kept as a nested document in MongoDB.</summary>
public sealed class Review
{
    /// <summary>The review's ID.</summary>
    public required string Id { get; init; }
    /// <summary>The rating from 1 to 5 stars.</summary>
    public required int Rating { get; init; }
    /// <summary>The headline.</summary>
    public required string Title { get; init; }
    /// <summary>The text of the review.</summary>
    public required string Body { get; init; }
    /// <summary>The author.</summary>
    public required ReviewAuthor Author { get; init; }
    /// <summary>How many readers found it helpful.</summary>
    public required int HelpfulVotes { get; init; }
    /// <summary>The store's answer. Absent until staff reply.</summary>
    public ReviewReply? Reply { get; init; }
    /// <summary>When the review was written.</summary>
    public required DateTimeOffset CreatedAt { get; init; }
}

/// <summary>How many reviews gave a rating.</summary>
public sealed class RatingBucket
{
    /// <summary>The stars, 1 to 5.</summary>
    public required int Stars { get; init; }
    /// <summary>How many reviews gave this rating.</summary>
    public required int Count { get; init; }
}

/// <summary>A product's reviews with their summary.</summary>
public sealed class ReviewPage
{
    /// <summary>The product reviewed.</summary>
    public required Guid ProductId { get; init; }
    /// <summary>The average rating from 1 to 5.</summary>
    public required double Average { get; init; }
    /// <summary>How many reviews the product has.</summary>
    public required int Count { get; init; }
    /// <summary>How the ratings spread, from 5 stars down to 1.</summary>
    public required IReadOnlyList<RatingBucket> Distribution { get; init; }
    /// <summary>The reviews, newest first.</summary>
    public required IReadOnlyList<Review> Reviews { get; init; }
}

/// <summary>A review to add.</summary>
public sealed class AddReviewRequest
{
    /// <summary>The rating from 1 to 5 stars.</summary>
    [Range(1, 5)] public int Rating { get; set; } = 5;
    /// <summary>The headline.</summary>
    [Required, StringLength(80, MinimumLength = 3)] public string Title { get; set; } = "";
    /// <summary>The text of the review.</summary>
    [Required, StringLength(2000, MinimumLength = 10)] public string Body { get; set; } = "";
    /// <summary>The customer writing it, from <c>CustomersController.List</c>. Customers can only review as themselves.</summary>
    public Guid CustomerId { get; set; }
}

/// <summary>A vote on how helpful a review is.</summary>
public sealed class ReviewVoteRequest
{
    /// <summary>Whether the review was helpful. Only helpful votes are counted.</summary>
    public bool Helpful { get; set; } = true;
}
