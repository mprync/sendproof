using Microsoft.Extensions.DependencyInjection;

namespace Sendproof.AspNetCore;

/// <summary>Configures the workbench and provides service registration for preview plugins.</summary>
public sealed class SendproofBuilder
{
    private readonly SendproofOptions _options;

    internal SendproofBuilder(IServiceCollection services, SendproofOptions options, CaptureContext capture)
    {
        Services = services;
        _options = options;
        Capture = capture;
    }

    /// <summary>
    /// Gets this host's capture slot. Data-store packages bind their hooks to it when they register, so a hook built
    /// outside the container (an AWS SDK pipeline handler, a driver event subscriber) still finds the current Preview.
    /// </summary>
    internal CaptureContext Capture { get; }

    /// <summary>Gets the host application's service collection.</summary>
    public IServiceCollection Services { get; }

    /// <summary>Loads custom field renderers from a JavaScript module served by the host application.</summary>
    /// <remarks>The module exports a fieldRenderers array of predicate and render functions.</remarks>
    public SendproofBuilder WithFieldModule(string url)
    {
        var path = LocalUrl.Validate(url);
        if (!_options.FieldModules.Contains(path, StringComparer.Ordinal))
        {
            _options.FieldModules.Add(path);
        }

        return this;
    }

    /// <summary>Sets the application-relative path and optional query for the same-origin OpenAPI document.</summary>
    public SendproofBuilder WithOpenApiUrl(string url)
    {
        _options.OpenApiUrl = LocalUrl.Validate(url);
        return this;
    }

    /// <summary>Adds a named same-origin OpenAPI document to the document selector.</summary>
    public SendproofBuilder WithOpenApiDocument(string name, string url)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(name);
        var document = new OpenApiDocument(name, LocalUrl.Validate(url));
        _options.Documents.RemoveAll(existing => string.Equals(existing.Name, name, StringComparison.OrdinalIgnoreCase));
        _options.Documents.Add(document);
        return this;
    }

    /// <summary>Overrides the displayed API name. The default is the host application name.</summary>
    public SendproofBuilder WithApiName(string name)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(name);
        _options.ApiName = name;
        return this;
    }

    /// <summary>Replaces the Development-only default with an explicit list of environments.</summary>
    public SendproofBuilder InEnvironments(params string[] environments)
    {
        ArgumentNullException.ThrowIfNull(environments);
        foreach (var environment in environments)
        {
            ArgumentException.ThrowIfNullOrWhiteSpace(environment);
        }

        _options.Environments = new HashSet<string>(environments, StringComparer.OrdinalIgnoreCase);
        return this;
    }

    /// <summary>Adds a host-managed sign-in integration with a same-origin path.</summary>
    public SendproofBuilder WithAuthProvider(string label, string kind, string url)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(label);
        ArgumentException.ThrowIfNullOrWhiteSpace(kind);
        _options.AuthProviders.Add(new AuthProvider(label, kind, LocalUrl.Validate(url)));
        return this;
    }

    /// <summary>Controls discovery of the host's displayable authentication schemes.</summary>
    public SendproofBuilder DiscoverAuthSchemes(bool enabled = true)
    {
        _options.DiscoverAuthSchemes = enabled;
        return this;
    }

    /// <summary>Controls capture of non-secret SQL parameter values. By default they are included only in Development.</summary>
    public SendproofBuilder WithSqlParameterValues(bool enabled)
    {
        _options.IncludeSqlParameterValues = enabled;
        return this;
    }

    /// <summary>
    /// Sets how long a preview session may sit unused, and live in all, before it is rolled back. The defaults are five and
    /// thirty minutes. A held session keeps a transaction open on one connection, so keep both short.
    /// </summary>
    public SendproofBuilder WithPreviewSessionLimits(TimeSpan idleTimeout, TimeSpan maxLifetime)
    {
        if (idleTimeout <= TimeSpan.Zero || maxLifetime <= TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(nameof(idleTimeout), "Preview session limits must be positive.");
        }

        _options.SessionIdleTimeout = idleTimeout;
        _options.SessionMaxLifetime = maxLifetime;
        return this;
    }

    internal void EnableEfCommandCapture() => _options.CaptureEfCommands = true;

    /// <summary>Requires the named host authorization policy for workbench routes and preview requests.</summary>
    public SendproofBuilder RequireAuthorization(string policyName)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(policyName);
        Services.AddAuthorization();
        _options.AuthorizationPolicy = policyName;
        return this;
    }
}
