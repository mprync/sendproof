using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

namespace TreasuryApi;

/// <summary>
/// Describes the document as a whole: the API's narrative, tags and sign-in, and corrections to generated schemas
/// (discriminated unions as <c>oneOf</c>, enum types, framework problem-details descriptions).
/// </summary>
internal static class DocumentDescriptions
{
    private const string Overview = """
        The **Acme Treasury API** is how the group treasury team looks after cash, pays suppliers and manages foreign exchange from one place. It covers the bank accounts of every Acme legal entity, their balances and statements, the people and companies Acme pays, payments with a four-eyes approval flow, and spot and forward FX deals.

        ## Payments in one minute

        A payment is created as a `Draft`, which immediately **reserves** its amount on the debit account. It is then **submitted** for approval (`PendingApproval`) and must be **approved by a different person** (`Approved`). The bank run schedules and sends it (`Scheduled`, `Sent`) and it ends as `Settled` or `Failed`. A reviewer can `Reject` a payment, which releases the reservation and lets the creator revise and resubmit it, and unsent payments can be `Cancelled`.

        ## Conventions

        - **Lists** are paged: pass `page` (from 1) and `pageSize` (1 to 100, default 25). Every list returns `{ items, page, pageSize, totalItems, totalPages }`. Lists can be filtered, searched with `q` and sorted with `sort`; a leading `-` reverses the order, as in `-amount`.
        - **Errors** follow [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) problem details. Invalid input is a `400` with an `errors` object keyed by field; business rules are `409` (the state does not allow it) or `422` (the request is understood but not allowed).
        - **Money** is a decimal with at most two fraction digits (none for JPY). **Dates** are ISO 8601; times are UTC.
        - **Idempotency:** send an `Idempotency-Key` header when creating a payment, so a retry cannot pay twice.

        ## Signing in

        Everything except sign-in needs a session cookie. Sign in with `AuthController.Login` using any seeded user and the password `Demo123!`, or in development pick a persona with `AuthController.SwitchPersona`. Roles decide what you may do:

        | Role | Can |
        | --- | --- |
        | `admin` | Everything, including accounts and user roles |
        | `payments.approve` | Create and submit payments, approve other people's, book FX deals |
        | `read-only` | Read everything, change nothing |

        ## About this example

        This is a disposable example for Test Bench, with seeded data that resets when you delete its database. **Preview** runs an operation for real and rolls the database back, showing the changes, notifications and SQL it would cause; **Send** commits them. No email, payment or bank is ever contacted.
        """;

    /// <summary>Descriptions of enums that only appear as optional properties, where the generator drops their XML comment.</summary>
    private static readonly Dictionary<string, string> EnumDescriptions = new()
    {
        ["ChargeBearer"] = "Which party pays the bank charges on a cross-border payment (ISO 20022 ChargeBearerType1Code): `SHA` shared, `OUR` the sender, `BEN` the beneficiary.",
        ["PurposeCode"] = "A subset of the ISO 20022 external purpose codes (ExternalPurpose1Code), such as `SUPP` for a supplier payment, `SALA` for salary and `TAXS` for tax."
    };

    private static readonly (string Name, string Description)[] Tags =
    [
        ("Authentication", "Sign in, sign out and switch between the seeded development personas. Sessions use a cookie."),
        ("Accounts", "The bank accounts of every Acme entity: list and read them, register new ones, freeze them and close them."),
        ("Balances", "Cash position: current ledger, available and reserved amounts per account, and each account's intraday history."),
        ("Counterparties", "The suppliers, customers, group companies and tax authorities Acme pays, with their bank details. Counterparties are archived, never deleted."),
        ("Payments", "Create, revise, submit and cancel payments. Payments reserve funds on creation and move through an approval flow before the bank sends them."),
        ("Approvals", "The four-eyes queue: payments waiting for review, and the decisions to approve or reject them. Nobody can approve their own payment."),
        ("FX deals", "Quote and book spot and forward foreign exchange deals, and list, read and cancel them."),
        ("Bank statements", "Daily statements delivered by the banks in the style of ISO 20022 camt.053, with their entries."),
        ("Users and roles", "The people who can sign in, the roles they hold and what each role allows. Admins change roles.")
    ];

    internal static Task TransformAsync(OpenApiDocument document, OpenApiDocumentTransformerContext context, CancellationToken cancellationToken)
    {
        document.Info.Title = "Acme Treasury API";
        document.Info.Version = "2.0.0";
        document.Info.Description = Overview;
        document.Info.Contact = new OpenApiContact { Name = "Acme Group Treasury", Email = "treasury-ops@acme.dev", Url = new Uri("https://example.com/treasury") };
        document.Info.License = new OpenApiLicense { Name = "MIT", Identifier = "MIT", Url = new Uri("https://opensource.org/licenses/MIT") };
        document.ExternalDocs = new OpenApiExternalDocs { Description = "Test Bench, the workbench that serves this API", Url = new Uri("https://example.com/test-bench") };
        document.Components ??= new OpenApiComponents();
        document.Components.SecuritySchemes ??= new Dictionary<string, IOpenApiSecurityScheme>();
        document.Components.SecuritySchemes[OperationDescriptions.CookieScheme] = new OpenApiSecurityScheme
        {
            Type = SecuritySchemeType.ApiKey,
            In = ParameterLocation.Cookie,
            Name = ".AspNetCore.Cookies",
            Description = "Sign in with a password or a development persona. The browser keeps the session cookie. Operations list the roles they accept as scopes."
        };
        document.Tags = Tags.Select(tag => new OpenApiTag { Name = tag.Name, Description = tag.Description }).ToHashSet();
        FixSchemas(document);
        return Task.CompletedTask;
    }

    /// <summary>
    /// Turns each discriminated union's <c>anyOf</c> into <c>oneOf</c> (exactly one variant applies), describes the
    /// discriminator property of every variant, types the enums and documents the framework problem-details schemas.
    /// </summary>
    private static void FixSchemas(OpenApiDocument document)
    {
        foreach (var (name, entry) in document.Components!.Schemas ?? new Dictionary<string, IOpenApiSchema>())
        {
            if (entry is not OpenApiSchema schema) continue;
            if (schema.Discriminator is { } discriminator && schema.AnyOf is { Count: > 0 } && schema.OneOf is not { Count: > 0 })
            {
                schema.OneOf = schema.AnyOf;
                schema.AnyOf = null;
                schema.Description ??= $"One of {string.Join(", ", discriminator.Mapping?.Keys ?? [])}, chosen by `{discriminator.PropertyName}`.";
                var mapping = discriminator.Mapping ?? new Dictionary<string, OpenApiSchemaReference>();
                foreach (var (value, target) in mapping)
                    if (document.Components.Schemas![target.Reference.Id!] is OpenApiSchema variant)
                        DescribeDiscriminator(variant, discriminator.PropertyName!, value);
            }
            if (schema.Enum is { Count: > 0 })
            {
                schema.Type ??= JsonSchemaType.String;
                // Nullable enum properties add null to the shared enum; a missing value is expressed on the property.
                var values = schema.Enum.Where(value => value is not null).ToList();
                if (values.Count != schema.Enum.Count) schema.Enum = values;
            }
            if (EnumDescriptions.TryGetValue(name, out var enumText)) schema.Description ??= enumText;
            if (name == "ProblemDetails" || name == "HttpValidationProblemDetails") DescribeProblemDetails(schema, name);
        }
    }

    private static void DescribeDiscriminator(OpenApiSchema variant, string property, string value)
    {
        if (variant.Properties is null || !variant.Properties.TryGetValue(property, out var entry) || entry is not OpenApiSchema discriminator) return;
        discriminator.Description ??= $"Always `{value}` for this variant. It tells the variants of the union apart.";
        variant.Required ??= new HashSet<string>();
        variant.Required.Add(property);
    }

    private static void DescribeProblemDetails(OpenApiSchema schema, string name)
    {
        schema.Description ??= name == "ProblemDetails"
            ? "An error in the RFC 9457 problem-details format."
            : "A request-validation error: problem details plus the failures per field.";
        foreach (var (property, text) in new Dictionary<string, string>
        {
            ["type"] = "A URI that identifies the kind of problem.",
            ["title"] = "A short summary of the problem. It does not change between occurrences.",
            ["status"] = "The HTTP status code of the response.",
            ["detail"] = "An explanation of this particular occurrence, written for the person using the API.",
            ["instance"] = "A URI that identifies this occurrence of the problem.",
            ["errors"] = "The validation failures: each key is the JSON name of a field (nested as `address.city`), each value the messages for it."
        })
            if (schema.Properties?.TryGetValue(property, out var entry) == true && entry is OpenApiSchema member)
                member.Description ??= text;
    }
}
