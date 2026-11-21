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
        builder.Services.TryAddSingleton<SendproofCommandInterceptor>();
        builder.Services.TryAddSingleton<SendproofTransactionInterceptor>();
        builder.Services.ConfigureDbContext<TContext>((services, options) =>
        {
            var interceptors = new IInterceptor[]
            {
                services.GetRequiredService<SendproofCommandInterceptor>(),
                services.GetRequiredService<SendproofTransactionInterceptor>()
            };
            var registered = options.Options.FindExtension<Microsoft.EntityFrameworkCore.Infrastructure.CoreOptionsExtension>()?.Interceptors;
            options.AddInterceptors(interceptors.Where(interceptor => registered?.Contains(interceptor) != true));
        });
        return builder;
    }
}
