using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using TestBench.AspNetCore;

namespace TestBench.EntityFrameworkCore;

/// <summary>Registers the EF Core preview provider.</summary>
public static class TestBenchEntityFrameworkCoreExtensions
{
    /// <summary>Uses an already registered, scoped relational context for preview requests.</summary>
    public static TestBenchBuilder AddEntityFrameworkCore<TContext>(this TestBenchBuilder builder)
        where TContext : DbContext
    {
        ArgumentNullException.ThrowIfNull(builder);
        builder.EnableEfCommandCapture();
        builder.Services.TryAddEnumerable(ServiceDescriptor.Scoped<IPreviewProvider, EntityFrameworkPreviewProvider<TContext>>());
        builder.Services.TryAddSingleton<TestBenchCommandInterceptor>();
        builder.Services.ConfigureDbContext<TContext>((services, options) =>
        {
            var interceptor = services.GetRequiredService<TestBenchCommandInterceptor>();
            if (options.Options.FindExtension<Microsoft.EntityFrameworkCore.Infrastructure.CoreOptionsExtension>()?
                .Interceptors?.Contains(interceptor) != true)
            {
                options.AddInterceptors(interceptor);
            }
        });
        return builder;
    }
}
