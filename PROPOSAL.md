# Sendproof

Sendproof is an open-source workbench for developers who need to know what an API call will actually do. A developer signs in to their API, selects an operation from its OpenAPI document, and edits a typed form. **Preview** runs an eligible operation and returns its response, tracked database changes and recorded effects after rollback. **Send** executes the ordinary request.

## Product decisions

| Decision | Consequence for an adopter |
| --- | --- |
| Mount inside the API at `/sendproof` | The workbench shares the application's origin, authenticated session, authorization pipeline and database configuration. |
| Ship ASP.NET Core and relational EF Core first | An existing scoped `DbContext` is sufficient for the first provider. A second ORM, raw SQL integration or non-.NET framework can be added independently. |
| Let the application choose authentication | SSO works on localhost and hosted development when the host's redirect URI is registered. Passwords, seeded personas and other methods appear according to host capabilities. |
| Generate the workbench from the API description | Consumers install a prebuilt web UI. They do not install Node, regenerate a client, or edit a second list of endpoints. |
| Treat the approved mocks as the design | Reuse the original stylesheet and icon sprite. Bind real operations, users, permissions, counts and results to those layouts. |
| Release under MIT | Maintain the packages, example, browser UI and versioned protocol together. |

## Installation and defaults

For an API already using the built-in OpenAPI endpoint and EF Core:

```csharp
builder.Services.AddSendproof()
    .AddEntityFrameworkCore<StoreDbContext>();

// With the application's ordinary API routes:
app.MapSendproof();
```

The ASP.NET Core adapter reads `/openapi/v1.json`, discovers displayable authentication handlers, and serves the workbench in Development. Without a database provider, the API still has a request editor and Send. To enable Preview, a host marks an endpoint or a group of reviewed endpoints with `.WithSendproofPreview()`, or places `[SendproofPreview]` on an MVC action or controller. A database registration alone cannot establish that a handler is free of external effects.

Applications can register separate v1 and v2 documents in the existing API picker, point the primary URL at Swashbuckle, or serve a build artifact at a local URL. ASP.NET Core's build-time OpenAPI tooling runs the application's entry point during the build. Example startup and database seeding should account for that when enabling build-time export. Either document source drives the same renderer. [Microsoft's OpenAPI generation guide](https://learn.microsoft.com/aspnet/core/fundamentals/openapi/aspnetcore-openapi?view=aspnetcore-10.0)

```csharp
builder.Services.AddSendproof()
    .InEnvironments("Development", "HostedDevelopment")
    .WithApiName("Store API")
    .WithOpenApiUrl("/swagger/v2/swagger.json")
    .WithOpenApiDocument("Version 1", "/swagger/v1/swagger.json")
    .WithAuthProvider("Company SSO", "oidc", "/account/sign-in")
    .RequireAuthorization("ApiDevelopers")
    .AddEntityFrameworkCore<StoreDbContext>();
```

The environment list replaces the default. The named policy and sign-in route belong to the host. A protected workbench needs a host challenge or sign-in route that the developer can reach before entering it. Registration examples and a runnable SQLite API are in the [quick start](README.md).

## What comes from OpenAPI

| Input | Workbench behavior |
| --- | --- |
| Paths, operations, tags and deprecation | Group operations in the sidebar. Filter by name, verb or route. Show operation details, documentation and request parameters in context. |
| JSON properties, required arrays, bounds and examples | Generate labeled fields, required indicators, optional-field disclosures, constraints and sample values. The host still validates every request. |
| Numbers, booleans, small enums, dates and date-times | Use typed controls. Preserve numeric and boolean values when switching between Form and JSON. |
| Local references, nested objects, arrays and schema variants | Resolve reusable definitions, add or remove array entries, and select a variant. Use JSON for a shape the form cannot represent. Bound recursive expansion. |
| IDs and money | Use an unambiguous matching collection schema for an ID and a compatible sibling currency for an amount. Allow explicit lookup URLs, label fields and currency fields. Send the database ID and fetch choices with the user's session. |
| Path, query and header parameters | Render each declared parameter and serialize it for its location. Generate an idempotency key only where the API declares one. Preserve the key when repeating the same logical request. |
| Request media types | Prepare JSON, text, URL-encoded or multipart bodies as appropriate. File inputs supply the browser's selected file and multipart boundary. |

OpenAPI describes a security requirement but cannot tell the browser which user is signed in, which rows they may read, or which services can be rolled back. The [bench protocol](spec/README.md) supplies those runtime facts. A form renderer can register an additional schema predicate and control without changing operation discovery or HTTP execution.

## Authentication and environment policy

API authentication stays in the host. The workbench handles navigation to a challenge, renders a configured password form, or invokes an explicitly configured persona source. A remote scheme uses the host's existing sign-in callback and established session. The same flow can use localhost or a hosted development hostname. API key, Windows, SAML and client-credentials installations can expose their own host-managed sign-in or token acquisition integration. Machine credentials need a server-side broker when confidential client secrets are involved.

The sample's Development-only persona source lists existing demo accounts. A switch issues the host's normal session for the selected account. A viewer trying a protected payment write must still receive an authorization denial. Production host applications do not acquire demo users or a persona endpoint by installing the package. A hosted team can choose SSO alone, or explicitly provide other methods and an access policy.

The authenticated application principal governs authorization and data visibility. EF uses the host's scoped context and configured database connection. Applications that implement tenant filters, row-level security or database impersonation continue to own that mapping.

## Preview execution and the rollback boundary

1. The browser sends the real method, query, headers and body to the reserved `/sendproof/_preview/…` route with `Prefer: tx=rollback`. It never retries a Preview as a Send.
2. The adapter identifies the original endpoint, applies the host's authorization and workbench policy, and checks its preview eligibility. Exactly one configured provider must own the request.
3. The EF provider begins a relational transaction on the handler's scoped context. It captures tracked inserts, updates and deletes around successful saves, including generated keys. Two saves of the same row can yield two changes.
4. The application can record an intended email, publication or webhook at its dispatch boundary and skip delivery during Preview. The preview journal holds those effects and any logs the application records for the request.
5. The host buffers the bounded result, rolls back and disposes the session before returning the envelope. The outer status describes the preview transport. The inner status and body describe the original endpoint, including validation errors.

**Coverage matters.** EF can roll back enlisted writes while showing a diff only for changes it observed. Raw SQL, database triggers and bulk updates can change rows without populating the EF change tracker. Separate connections, caches, files, calls to another service and work queued after the request require their own guarantees. Database sequences may advance through rollback. A host should enable Preview only when its complete request path meets the declared boundary. The [EF transaction guide](https://learn.microsoft.com/en-us/ef/core/saving/transactions) and [provider coverage notes](adapters/dotnet/Sendproof.EntityFrameworkCore/README.md) explain the underlying guarantees.

## Extension architecture

| Module | Public contract | Example extension |
| --- | --- | --- |
| Web UI | OpenAPI plus the versioned HTTP protocol | A FastAPI adapter can serve the same assets and implement capabilities and preview transport in Python. |
| ASP.NET Core adapter | Fluent `SendproofBuilder`, endpoint metadata, host services | A package adds its own builder extension, registers services, and returns the same builder. |
| Persistence | Scoped `IPreviewProvider` and disposable `IPreviewSession` | A Dapper or raw ADO.NET plugin begins a transaction on the application's own connection and exposes that same transaction to all participating commands. |
| Effects | Scoped `SendproofPreview` journal | An email adapter records an intended message during Preview and calls the real sender during Send. |
| Request controls | Schema renderer registry and OpenAPI extensions | An application-specific picker binds a label to a typed JSON value. |
| Exports | Prepared request, credential masking, format-specific writer | Add a language without changing request construction, execution, or visual layout. |

A raw SQL provider must define how it enlists commands, handles cancellation and obtains a diff. If it can guarantee rollback but has only statement counts, the UI should describe that coverage explicitly. It must never synthesize before/after rows. A host that mixes independent databases requires a provider that can account for the entire operation before it can advertise Preview. External framework adapters implement HTTP and do not load .NET assemblies. The [contributor guide](CONTRIBUTING.md) identifies the code and checks for each boundary.

## Features selected from other API tools

Swagger UI demonstrates the adoption model teams already understand: generate an operation list from the API description and try a call in the browser. Redoc CE demonstrates searchable schemas, request examples and a three-panel reference. Both can use the same OpenAPI document as Sendproof. The reason to add a host adapter is to observe the application's real transaction and authorization path, which the description alone cannot expose. [Swagger UI](https://swagger.io/open-source/swagger-ui/) · [Redoc CE](https://redocly.com/docs/redoc)

Scalar already renders OpenAPI operations and examples, generates request snippets, and supports multiple client workflows. Its snippet picker is a good fit for the mock's existing **Code** tab. Sendproof exports the *edited* request as cURL, C# HttpClient or an HTTP file. It also supports multiple documents through the mock's existing API switcher. The initial proposal's claim that Scalar is the default UI in ASP.NET templates was incorrect. Microsoft includes document generation and leaves UI installation to the application. [Scalar code generation](https://scalar.com/products/api-client/code-generation) · [Scalar request examples](https://scalar.com/products/api-references/blocks/code-example) · [ASP.NET Core OpenAPI](https://learn.microsoft.com/aspnet/core/fundamentals/openapi/aspnetcore-openapi?view=aspnetcore-10.0)

PostgREST supplies a precedent for an explicit transaction rollback preference. Sendproof adds a separate addressed transport and a confirmation envelope so the developer can inspect the result before making a real call. [PostgREST transaction preferences](https://docs.postgrest.org/en/stable/references/api/preferences.html#transaction-end-preference)

Three additions shorten common testing loops without changing the approved designs:

- **Reproduce a case.** Fill from a schema example, edit in Form or JSON, then export or restore a recent request as an editable draft. Replaying a draft requires an explicit execution.
- **Understand failure.** Keep the request visible, map validation errors to fields, and retain the response body, status and timing for diagnosis. A connection failure leaves the outcome of an in-flight Send unknown.
- **Compare access.** Switch between real development users and exercise the same endpoint through its normal authorization policy. A successful sign-in alone is insufficient evidence of permission for a particular row.

## Visual acceptance

The [nine approved screens](mocks/screens/) and their source HTML define the shell, typography, colors, icons, field layout, responsive breakpoints and interactions. Desktop has the operation sidebar, request editor and result panel. Mobile uses the Request/Result switch and persistent actions. The sign-in page shows only available methods. The validation, palette and result-state mocks cover error, empty and loading behavior.

Design acceptance compares those states at the original desktop and mobile viewports in light and dark themes, with large text and keyboard navigation. WCAG 2.2 AA is the release target. Verification includes keyboard-only operation, focus restoration, readable labels and errors, screen-reader announcements and reflow. A screenshot comparison alone cannot establish conformance.

## Release boundaries

The first source distribution includes the ASP.NET Core adapter, relational EF Core provider, embedded UI, SQLite example, tests and local NuGet packaging. The [adapter contract](spec/README.md) documents the current protocol. The first public release should follow passing integration and browser checks, an accessibility review, and publication under agreed package IDs. Future contributions can add raw SQL/Dapper, other languages, library-specific effect adapters and named example selection using the same Code tab and Fill sample control. These have explicit extension points and can ship independently.
