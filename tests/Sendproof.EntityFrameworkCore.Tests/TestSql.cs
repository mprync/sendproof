using Microsoft.EntityFrameworkCore;

namespace Sendproof.EntityFrameworkCore.Tests;

/// <summary>
/// Runs statements that cannot be parameterized, such as <c>CREATE DATABASE</c> with a generated name. Callers pass only
/// names the test generated itself, never input.
/// </summary>
internal static class TestSql
{
    internal static Task<int> RunAsync(this DbContext context, string sql) =>
        context.Database.ExecuteSqlRawAsync(sql);
}
