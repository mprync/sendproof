using Microsoft.EntityFrameworkCore;
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
        builder.Services.ConfigureDbContext<TContext>((services, options) =>
        {
            var interceptor = services.GetRequiredService<SendproofCommandInterceptor>();
            if (options.Options.FindExtension<Microsoft.EntityFrameworkCore.Infrastructure.CoreOptionsExtension>()?
                .Interceptors?.Contains(interceptor) != true)
            {
                options.AddInterceptors(interceptor);
            }
        });
        return builder;
    }
}
