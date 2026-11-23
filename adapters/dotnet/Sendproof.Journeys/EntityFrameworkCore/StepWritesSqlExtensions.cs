using Microsoft.EntityFrameworkCore;

namespace Sendproof.Journeys.EntityFrameworkCore;

/// <summary>Adds the SQL entry point to <see cref="StepWrites"/>.</summary>
public static class StepWritesSqlExtensions
{
    /// <summary>The rows the step should write through <typeparamref name="TDbContext"/>.</summary>
    public static SqlWrites<TDbContext> Sql<TDbContext>(this StepWrites writes) where TDbContext : DbContext
    {
        ArgumentNullException.ThrowIfNull(writes);
        return new SqlWrites<TDbContext>(writes);
    }
}
