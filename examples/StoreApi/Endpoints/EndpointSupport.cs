using System.ComponentModel.DataAnnotations;
using System.Reflection;
using System.Security.Claims;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace StoreApi;

/// <summary>Declares the values a list operation accepts for its <c>sort</c> query parameter.</summary>
/// <param name="Values">The accepted values, such as <c>name</c> and <c>-price</c>. A leading minus sorts descending.</param>
/// <param name="Descriptions">Optional plain-language description of each value, published as <c>x-enum-descriptions</c>.</param>
internal sealed record SortKeysMetadata(string[] Values, IReadOnlyDictionary<string, string>? Descriptions = null);

/// <summary>One operation that supersedes a deprecated one, published in the <c>x-replaced-by</c> list.</summary>
/// <param name="OperationId">The replacement's operation ID, such as <c>StockController.Get</c>.</param>
/// <param name="Description">What the replacement does differently.</param>
/// <param name="Parameters">Optional map from the replacement's parameters to OpenAPI runtime expressions over the deprecated request, such as <c>$request.path.id</c>.</param>
internal sealed record ReplacementOperation(string OperationId, string Description, IReadOnlyDictionary<string, string>? Parameters = null);

/// <summary>
/// Declares how a deprecated operation is retired: what replaces it and when it stops working. Read by the OpenAPI
/// operation transformer (<c>x-replaced-by</c>, <c>x-sunset</c>) and by the endpoint, which sends the matching
/// <c>Sunset</c> header (RFC 8594).
/// </summary>
/// <param name="Replacements">The operations to use instead.</param>
/// <param name="Sunset">The date the operation is removed.</param>
internal sealed record DeprecationMetadata(IReadOnlyList<ReplacementOperation> Replacements, DateOnly Sunset)
{
    /// <summary>The sunset date as an RFC 9110 HTTP-date (midnight UTC), the format of the <c>Sunset</c> header.</summary>
    internal string SunsetHttpDate => new DateTimeOffset(Sunset.ToDateTime(TimeOnly.MinValue), TimeSpan.Zero).ToString("R", System.Globalization.CultureInfo.InvariantCulture);
}

/// <summary>Helpers shared by the endpoint groups: paging, validation, problem responses and the current user.</summary>
internal static class EndpointSupport
{
    /// <summary>The page size used when a list request does not say.</summary>
    internal const int DefaultPageSize = 25;
    /// <summary>The largest page size a list request may ask for.</summary>
    internal const int MaxPageSize = 100;

    /// <summary>The signed-in user's email address.</summary>
    internal static string Email(this ClaimsPrincipal principal) => principal.FindFirstValue(ClaimTypes.Email)!;

    /// <summary>The signed-in user's display name.</summary>
    internal static string DisplayName(this ClaimsPrincipal principal) => principal.Identity!.Name!;

    /// <summary>Returns a 404 problem naming the missing thing.</summary>
    internal static IResult NotFound(string what, object id) =>
        Results.Problem(title: "Not found", detail: $"No {what} exists with ID {id}.", statusCode: StatusCodes.Status404NotFound);

    /// <summary>Returns a 403 problem for a signed-in user who may not touch this record.</summary>
    internal static IResult Forbidden(string detail) =>
        Results.Problem(title: "Forbidden", detail: detail, statusCode: StatusCodes.Status403Forbidden);

    /// <summary>
    /// Whether the signed-in user may act for a customer: staff always may, a customer only for themselves.
    /// </summary>
    internal static bool CanActFor(this ClaimsPrincipal principal, CustomerRecord customer) =>
        principal.IsStaff() || string.Equals(customer.Email, principal.Email(), StringComparison.OrdinalIgnoreCase);

    /// <summary>The message of the 403 a customer gets for another customer's record.</summary>
    internal const string NotYours = "You can only see and change your own records.";

    /// <summary>Returns a 409 problem for a request that conflicts with the current state.</summary>
    internal static IResult Conflict(string detail) =>
        Results.Problem(title: "Conflict", detail: detail, statusCode: StatusCodes.Status409Conflict);

    /// <summary>Returns a 422 problem for a well-formed request that breaks a business rule.</summary>
    internal static IResult Unprocessable(string detail) =>
        Results.Problem(title: "Business rule violated", detail: detail, statusCode: StatusCodes.Status422UnprocessableEntity);

    /// <summary>Converts a PascalCase member name to the camelCase JSON name.</summary>
    internal static string Camel(string name) => name.Length == 0 ? name : char.ToLowerInvariant(name[0]) + name[1..];

    /// <summary>
    /// Checks the page number and size and returns the offset errors, keyed by parameter name.
    /// </summary>
    internal static void CheckPaging(int page, int pageSize, Dictionary<string, string[]> errors)
    {
        if (page < 1) errors["page"] = ["The page number starts at 1."];
        if (pageSize is < 1 or > MaxPageSize) errors["pageSize"] = [$"The page size must be between 1 and {MaxPageSize}."];
    }

    /// <summary>Checks that <paramref name="sort"/> is one of the allowed values.</summary>
    internal static void CheckSort(string? sort, string[] allowed, Dictionary<string, string[]> errors)
    {
        if (sort is not null && !allowed.Contains(sort))
            errors["sort"] = [$"Use one of: {string.Join(", ", allowed)}."];
    }

    /// <summary>Checks that a date range, when both ends are given, does not end before it starts.</summary>
    internal static void CheckRange(DateOnly? from, DateOnly? to, string fromName, string toName, Dictionary<string, string[]> errors)
    {
        if (from is not null && to is not null && to < from) errors[toName] = [$"{toName} must not be before {fromName}."];
    }

    /// <summary>Escapes <c>%</c> and <c>_</c> so search text is matched literally by <c>LIKE</c>.</summary>
    internal static string LikePattern(string text) =>
        "%" + text.Trim().Replace("\\", "\\\\").Replace("%", "\\%").Replace("_", "\\_") + "%";

    /// <summary>Runs the data-annotation checks of a request and returns failures keyed by JSON property name.</summary>
    internal static Dictionary<string, string[]> Validate(object model)
    {
        var errors = new Dictionary<string, string[]>();
        Validate(model, "", errors);
        return errors;
    }

    private static void Validate(object model, string prefix, Dictionary<string, string[]> errors)
    {
        var results = new List<ValidationResult>();
        Validator.TryValidateObject(model, new ValidationContext(model), results, validateAllProperties: true);
        foreach (var result in results)
        {
            var members = result.MemberNames.Any() ? result.MemberNames : [""];
            foreach (var member in members)
            {
                var key = prefix + Camel(member);
                errors[key] = [.. errors.GetValueOrDefault(key, []), result.ErrorMessage ?? "The value is invalid."];
            }
        }
        // Validate nested objects too, with dotted paths like address.city.
        foreach (var property in model.GetType().GetProperties(BindingFlags.Public | BindingFlags.Instance))
        {
            if (property.GetIndexParameters().Length > 0 || property.PropertyType.IsPrimitive || property.PropertyType.IsEnum ||
                property.PropertyType == typeof(string) || property.PropertyType.Namespace?.StartsWith("System") == true) continue;
            if (property.GetValue(model) is { } child) Validate(child, prefix + Camel(property.Name) + ".", errors);
        }
    }

    /// <summary>Builds one page of a query, sorted and mapped to its contract.</summary>
    internal static async Task<PagedList<TItem>> PageAsync<TEntity, TItem>(
        IQueryable<TEntity> query, int page, int pageSize, Func<IReadOnlyList<TEntity>, Task<IReadOnlyList<TItem>>> map)
    {
        var total = await query.CountAsync();
        var rows = await query.Skip((page - 1) * pageSize).Take(pageSize).ToListAsync();
        return new PagedList<TItem>
        {
            Items = await map(rows), Page = page, PageSize = pageSize, TotalItems = total,
            TotalPages = (int)Math.Ceiling(total / (double)pageSize)
        };
    }

    /// <summary>Applies a sort expression chosen by a <c>sort</c> value, then a stable tie-breaker.</summary>
    internal static IOrderedQueryable<T> Sorted<T, TKey, TTie>(IQueryable<T> query, bool descending,
        System.Linq.Expressions.Expression<Func<T, TKey>> key, System.Linq.Expressions.Expression<Func<T, TTie>> tie) =>
        descending ? query.OrderByDescending(key).ThenBy(tie) : query.OrderBy(key).ThenBy(tie);

    /// <summary>The number of fraction digits a currency allows.</summary>
    internal static int Decimals(Currency currency) => currency == Currency.JPY ? 0 : 2;

    /// <summary>Whether an amount has more fraction digits than its currency allows.</summary>
    internal static bool HasTooManyDecimals(decimal amount, Currency currency) =>
        decimal.Round(amount, Decimals(currency)) != amount;

    /// <summary>Returns a validation problem result for the given errors.</summary>
    internal static IResult ValidationProblem(Dictionary<string, string[]> errors) => Results.ValidationProblem(errors);

    /// <summary>Builds a <see cref="Money"/> value.</summary>
    internal static Money ToMoney(decimal value, Currency currency) => new() { Value = value, Currency = currency };

    /// <summary>Parses a currency code that must be spelled exactly as the enum.</summary>
    internal static Currency? ParseCurrency(string? code) =>
        Enum.TryParse<Currency>(code, ignoreCase: false, out var value) && Enum.IsDefined(value) ? value : null;

    /// <summary>The names of every currency, as the message of an invalid-currency error.</summary>
    internal static string CurrencyNames => string.Join(", ", Enum.GetNames<Currency>());

    /// <summary>Parses a shipping speed spelled as the API sends it (<c>Standard</c>, <c>Express</c> or <c>Next day</c>).</summary>
    internal static ShippingSpeed? ParseSpeed(string? text) => text switch
    {
        "Standard" => ShippingSpeed.Standard,
        "Express" => ShippingSpeed.Express,
        "Next day" => ShippingSpeed.NextDay,
        _ => null
    };

    /// <summary>Whether the signed-in user works for the store (anything but a customer).</summary>
    internal static bool IsStaff(this ClaimsPrincipal principal) => !principal.IsInRole("customer");

    /// <summary>Records an audit event for a business object.</summary>
    internal static void Audit(this StoreDbContext db, string entityType, object entityId, string action, string actor) =>
        db.AuditEvents.Add(new AuditEventRecord
        {
            Id = Guid.NewGuid(), EntityType = entityType, EntityId = entityId.ToString()!, Action = action,
            Actor = actor, CreatedAt = DateTimeOffset.UtcNow
        });
}
