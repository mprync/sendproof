using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Sendproof.AspNetCore;

namespace Sendproof.EntityFrameworkCore;

/// <summary>Registers the EF Core preview provider.</summary>
public static class SendproofEntityFrameworkCoreExtensions
{
    /// <summary>Uses an already registered, scoped relational context for preview requests.</summary>
    public static SendproofBuilder AddEntityFrameworkCore<TContext>(this SendproofBuilder builder)
        where TContext : DbContext
    {
        ArgumentNullException.ThrowIfNull(builder);
        builder.EnableEfCommandCapture();
        builder.Services.TryAddEnumerable(ServiceDescriptor.Scoped<IPreviewProvider, EntityFrameworkPreviewProvider<TContext>>());
        SafeProcedures.Of(builder.Services);
        builder.Services.TryAddSingleton<SendproofCommandInterceptor>();
        builder.Services.TryAddSingleton<SendproofTransactionInterceptor>();
        builder.Services.TryAddSingleton<SendproofConnectionInterceptor>();
        builder.Services.TryAddSingleton<SendproofCommitDiagnostics>();
        builder.Services.ConfigureDbContext<TContext>((services, options) =>
        {
            // Started before the context can save: refuses commits by providers without interceptors (MongoDB's).
            _ = services.GetRequiredService<SendproofCommitDiagnostics>();
            var interceptors = new IInterceptor[]
            {
                services.GetRequiredService<SendproofCommandInterceptor>(),
                services.GetRequiredService<SendproofTransactionInterceptor>(),
                // Guards plain ADO.NET and Dapper on Database.GetDbConnection() too (see SendproofDbConnection).
                services.GetRequiredService<SendproofConnectionInterceptor>()
            };
            var registered = options.Options.FindExtension<Microsoft.EntityFrameworkCore.Infrastructure.CoreOptionsExtension>()?.Interceptors;
            options.AddInterceptors(interceptors.Where(interceptor => registered?.Contains(interceptor) != true));
        });
        return builder;
    }

    /// <summary>
    /// Declares MySQL or MariaDB stored procedures that never commit, so a Preview may <c>CALL</c> them. Every other
    /// <c>CALL</c> (and command of type <c>StoredProcedure</c>) is refused during a Preview, because a procedure can run
    /// <c>COMMIT</c> or an implicitly committing statement inside the Preview transaction.
    /// </summary>
    /// <remarks>
    /// <b>Warning:</b> this is your statement that the procedures never commit. Sendproof trusts it: a listed procedure
    /// that commits persists the Preview's writes. Names match exactly (<c>audit_touch</c> or
    /// <c>reports.refresh_totals</c>), case-insensitively, with no wildcards.
    /// </remarks>
    /// <exception cref="ArgumentException">A name is blank or has a wildcard or whitespace.</exception>
    public static SendproofBuilder WithSafeProcedures(this SendproofBuilder builder, params string[] names)
    {
        ArgumentNullException.ThrowIfNull(builder);
        ArgumentNullException.ThrowIfNull(names);
        SafeProcedures.Of(builder.Services).Names.UnionWith(SqlStatements.SafeProcedures(names));
        return builder;
    }
}

/// <summary>The host-declared safe procedures of <see cref="SendproofEntityFrameworkCoreExtensions.WithSafeProcedures"/>.</summary>
internal sealed class SafeProcedures
{
    internal HashSet<string> Names { get; } = new(StringComparer.Ordinal);

    /// <summary>The registered instance, registering an empty one first if there is none.</summary>
    internal static SafeProcedures Of(IServiceCollection services)
    {
        if (services.FirstOrDefault(descriptor => descriptor.ServiceType == typeof(SafeProcedures))?.ImplementationInstance is SafeProcedures existing)
        {
            return existing;
        }

        var created = new SafeProcedures();
        services.AddSingleton(created);
        return created;
    }
}
