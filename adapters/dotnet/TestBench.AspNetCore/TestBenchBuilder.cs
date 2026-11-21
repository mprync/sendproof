using Microsoft.Extensions.DependencyInjection;

namespace TestBench.AspNetCore;

/// <summary>Configures the workbench and provides service registration for preview plugins.</summary>
public sealed class TestBenchBuilder
{
    private readonly TestBenchOptions _options;

    internal TestBenchBuilder(IServiceCollection services, TestBenchOptions options)
    {
        Services = services;
        _options = options;
    }

    /// <summary>Gets the host application's service collection.</summary>
    public IServiceCollection Services { get; }

    /// <summary>Loads custom field renderers from a JavaScript module served by the host application.</summary>
    /// <remarks>The module exports a fieldRenderers array of predicate and render functions.</remarks>
    public TestBenchBuilder WithFieldModule(string url)
    {
        var path = LocalUrl.Validate(url);
        if (!_options.FieldModules.Contains(path, StringComparer.Ordinal))
        {
            _options.FieldModules.Add(path);
        }

        return this;
    }

    /// <summary>Sets the application-relative path and optional query for the same-origin OpenAPI document.</summary>
    public TestBenchBuilder WithOpenApiUrl(string url)
    {
        _options.OpenApiUrl = LocalUrl.Validate(url);
        return this;
    }

    /// <summary>Adds a named same-origin OpenAPI document to the document selector.</summary>
    public TestBenchBuilder WithOpenApiDocument(string name, string url)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(name);
        var document = new OpenApiDocument(name, LocalUrl.Validate(url));
        _options.Documents.RemoveAll(existing => string.Equals(existing.Name, name, StringComparison.OrdinalIgnoreCase));
        _options.Documents.Add(document);
        return this;
    }

    /// <summary>Overrides the displayed API name. The default is the host application name.</summary>
    public TestBenchBuilder WithApiName(string name)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(name);
        _options.ApiName = name;
        return this;
    }

    /// <summary>Replaces the Development-only default with an explicit list of environments.</summary>
    public TestBenchBuilder InEnvironments(params string[] environments)
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
    public TestBenchBuilder WithAuthProvider(string label, string kind, string url)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(label);
        ArgumentException.ThrowIfNullOrWhiteSpace(kind);
        _options.AuthProviders.Add(new AuthProvider(label, kind, LocalUrl.Validate(url)));
        return this;
    }

    /// <summary>Controls discovery of the host's displayable authentication schemes.</summary>
    public TestBenchBuilder DiscoverAuthSchemes(bool enabled = true)
    {
        _options.DiscoverAuthSchemes = enabled;
        return this;
    }

    /// <summary>Controls capture of non-secret SQL parameter values. By default they are included only in Development.</summary>
    public TestBenchBuilder WithSqlParameterValues(bool enabled)
    {
        _options.IncludeSqlParameterValues = enabled;
        return this;
    }

    internal void EnableEfCommandCapture() => _options.CaptureEfCommands = true;

    /// <summary>Requires the named host authorization policy for workbench routes and preview requests.</summary>
    public TestBenchBuilder RequireAuthorization(string policyName)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(policyName);
        Services.AddAuthorization();
        _options.AuthorizationPolicy = policyName;
        return this;
    }
}
