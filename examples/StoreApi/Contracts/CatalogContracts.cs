using System.ComponentModel.DataAnnotations;

namespace StoreApi;

/// <summary>A group of products, such as <c>Running shoes</c>.</summary>
public sealed class Category
{
    /// <summary>The category's ID.</summary>
    public required Guid Id { get; init; }
    /// <summary>The URL-safe name.</summary>
    public required string Slug { get; init; }
    /// <summary>The display name.</summary>
    public required string Name { get; init; }
    /// <summary>What the category holds.</summary>
    public string? Description { get; init; }
    /// <summary>The parent category's ID. Absent for a top-level category.</summary>
    public Guid? ParentId { get; init; }
    /// <summary>How many active products the category holds.</summary>
    public required int ProductCount { get; init; }
}

/// <summary>A short description of a category, embedded in products.</summary>
public sealed class CategoryReference
{
    /// <summary>The category's ID.</summary>
    public required Guid Id { get; init; }
    /// <summary>The display name.</summary>
    public required string Name { get; init; }
}

/// <summary>The details of a new category.</summary>
public sealed class CreateCategoryRequest
{
    /// <summary>The display name.</summary>
    [Required, StringLength(60, MinimumLength = 2)] public string Name { get; set; } = "";
    /// <summary>The URL-safe name: lower-case letters, digits and hyphens.</summary>
    [Required, RegularExpression("^[a-z0-9]+(-[a-z0-9]+)*$")] public string Slug { get; set; } = "";
    /// <summary>What the category holds.</summary>
    [MaxLength(300)] public string? Description { get; set; }
    /// <summary>The parent category, from <c>CategoriesController.List</c>. Leave it out for a top-level category.</summary>
    public Guid? ParentId { get; set; }
}

/// <summary>The size of a boxed product.</summary>
public sealed class Dimensions
{
    /// <summary>The width in centimetres.</summary>
    public required decimal WidthCm { get; init; }
    /// <summary>The height in centimetres.</summary>
    public required decimal HeightCm { get; init; }
    /// <summary>The depth in centimetres.</summary>
    public required decimal DepthCm { get; init; }
}

/// <summary>A product as listed in the storefront, priced in one currency.</summary>
public sealed class ProductSummary
{
    /// <summary>The product's ID.</summary>
    public required Guid Id { get; init; }
    /// <summary>The URL-safe name.</summary>
    public required string Slug { get; init; }
    /// <summary>The display name.</summary>
    public required string Name { get; init; }
    /// <summary>The maker.</summary>
    public required string Brand { get; init; }
    /// <summary>The category.</summary>
    public required CategoryReference Category { get; init; }
    /// <summary>Whether the product can be bought.</summary>
    public required ProductStatus Status { get; init; }
    /// <summary>The lowest variant price, in the currency you asked for.</summary>
    public required Money Price { get; init; }
    /// <summary>The average review rating from 1 to 5. Zero when there are no reviews.</summary>
    public required double Rating { get; init; }
    /// <summary>How many reviews the product has.</summary>
    public required int ReviewCount { get; init; }
    /// <summary>Whether at least one variant is in stock.</summary>
    public required bool InStock { get; init; }
    /// <summary>Tags such as <c>waterproof</c> or <c>new</c>.</summary>
    public required IReadOnlyList<string> Tags { get; init; }
}

/// <summary>One purchasable version of a product.</summary>
public sealed class Variant
{
    /// <summary>The variant's ID.</summary>
    public required Guid Id { get; init; }
    /// <summary>The stock-keeping unit.</summary>
    public required string Sku { get; init; }
    /// <summary>The options, such as <c>Black / M</c>.</summary>
    public required string Name { get; init; }
    /// <summary>The colour option, if the product has one.</summary>
    public string? Color { get; init; }
    /// <summary>The size option, if the product has one.</summary>
    public string? Size { get; init; }
    /// <summary>The barcode (EAN-13).</summary>
    public string? Barcode { get; init; }
    /// <summary>The price in every currency the store sells in.</summary>
    public required IReadOnlyList<Money> Prices { get; init; }
    /// <summary>The units that can be bought now: on hand minus reserved.</summary>
    public required int Available { get; init; }
}

/// <summary>A product with its description, dimensions and variants.</summary>
public sealed class Product
{
    /// <summary>The product's ID.</summary>
    public required Guid Id { get; init; }
    /// <summary>The URL-safe name.</summary>
    public required string Slug { get; init; }
    /// <summary>The display name.</summary>
    public required string Name { get; init; }
    /// <summary>The maker.</summary>
    public required string Brand { get; init; }
    /// <summary>The description, in Markdown.</summary>
    public required string Description { get; init; }
    /// <summary>The category.</summary>
    public required CategoryReference Category { get; init; }
    /// <summary>Whether the product can be bought.</summary>
    public required ProductStatus Status { get; init; }
    /// <summary>Tags such as <c>waterproof</c> or <c>new</c>.</summary>
    public required IReadOnlyList<string> Tags { get; init; }
    /// <summary>The weight in grams.</summary>
    public required int WeightGrams { get; init; }
    /// <summary>The size of the box.</summary>
    public required Dimensions Dimensions { get; init; }
    /// <summary>The average review rating from 1 to 5. Zero when there are no reviews.</summary>
    public required double Rating { get; init; }
    /// <summary>How many reviews the product has.</summary>
    public required int ReviewCount { get; init; }
    /// <summary>The variants, each with its SKU, prices and availability.</summary>
    public required IReadOnlyList<Variant> Variants { get; init; }
    /// <summary>When the product was created.</summary>
    public required DateTimeOffset CreatedAt { get; init; }
    /// <summary>When the product last changed.</summary>
    public required DateTimeOffset UpdatedAt { get; init; }
}

/// <summary>A variant of a new product.</summary>
public sealed class CreateVariantRequest
{
    /// <summary>The stock-keeping unit: 6 to 24 upper-case letters, digits and hyphens. It must be unique.</summary>
    [Required, RegularExpression("^[A-Z0-9-]{6,24}$")] public string Sku { get; set; } = "";
    /// <summary>The colour option.</summary>
    [MaxLength(30)] public string? Color { get; set; }
    /// <summary>The size option.</summary>
    [MaxLength(30)] public string? Size { get; set; }
    /// <summary>The number of units on the shelf to start with.</summary>
    [Range(0, 100000)] public int InitialStock { get; set; }
}

/// <summary>The details of a new product.</summary>
public sealed class CreateProductRequest
{
    /// <summary>The display name.</summary>
    [Required, StringLength(120, MinimumLength = 3)] public string Name { get; set; } = "";
    /// <summary>The URL-safe name: lower-case letters, digits and hyphens.</summary>
    [Required, RegularExpression("^[a-z0-9]+(-[a-z0-9]+)*$")] public string Slug { get; set; } = "";
    /// <summary>The maker.</summary>
    [Required, MaxLength(60)] public string Brand { get; set; } = "";
    /// <summary>The description, in Markdown.</summary>
    [Required, MaxLength(4000)] public string Description { get; set; } = "";
    /// <summary>The category, from <c>CategoriesController.List</c>.</summary>
    public Guid CategoryId { get; set; }
    /// <summary>The base price of every variant, in <c>currency</c>. The other currencies are derived from it.</summary>
    public decimal Price { get; set; }
    /// <summary>The currency of <c>price</c>.</summary>
    public string Currency { get; set; } = "USD";
    /// <summary>The weight in grams.</summary>
    [Range(1, 500000)] public int WeightGrams { get; set; } = 500;
    /// <summary>The size of the box. Optional.</summary>
    public DimensionsInput? Dimensions { get; set; }
    /// <summary>Tags such as <c>waterproof</c>.</summary>
    public string[]? Tags { get; set; }
    /// <summary>The variants to create. At least one is needed.</summary>
    [Required, MinLength(1), MaxLength(40)] public CreateVariantRequest[] Variants { get; set; } = [];
}

/// <summary>The size of a box, as sent when creating or changing a product.</summary>
public sealed class DimensionsInput
{
    /// <summary>The width in centimetres.</summary>
    [Range(0.1, 500)] public decimal WidthCm { get; set; }
    /// <summary>The height in centimetres.</summary>
    [Range(0.1, 500)] public decimal HeightCm { get; set; }
    /// <summary>The depth in centimetres.</summary>
    [Range(0.1, 500)] public decimal DepthCm { get; set; }
}

/// <summary>The new values of a product. Every field is replaced.</summary>
public sealed class UpdateProductRequest
{
    /// <summary>The display name.</summary>
    [Required, StringLength(120, MinimumLength = 3)] public string Name { get; set; } = "";
    /// <summary>The description, in Markdown.</summary>
    [Required, MaxLength(4000)] public string Description { get; set; } = "";
    /// <summary>The category, from <c>CategoriesController.List</c>.</summary>
    public Guid CategoryId { get; set; }
    /// <summary>Whether the product can be bought: <c>Draft</c>, <c>Active</c> or <c>Archived</c>.</summary>
    public string Status { get; set; } = "Active";
    /// <summary>Tags such as <c>waterproof</c>.</summary>
    public string[]? Tags { get; set; }
}

/// <summary>A hit of the retired v1 product search.</summary>
public sealed class LegacyProductHit
{
    /// <summary>The product's ID.</summary>
    public required Guid Id { get; init; }
    /// <summary>The display name.</summary>
    public required string Name { get; init; }
    /// <summary>The lowest US-dollar price.</summary>
    public required decimal Price { get; init; }
}
