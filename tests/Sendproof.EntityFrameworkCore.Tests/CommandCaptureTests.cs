using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Sendproof.AspNetCore;
using Sendproof.EntityFrameworkCore;
using Xunit;

namespace Sendproof.EntityFrameworkCore.Tests;

public sealed class CommandCaptureTests
{
    [Theory]
    [InlineData("@idempotencyKey", false)]
    [InlineData("WHERE \"p\".\"IdempotencyKey\" = @p0", false)]
    [InlineData("@tokenCount", true)]
    [InlineData("@monkey", false)]
    [InlineData("@PasswordHash", true)]
    [InlineData("$salt", true)]
    [InlineData("@api_key", true)]
    [InlineData("@ApiKey", true)]
    [InlineData("@privateKey", true)]
    [InlineData("@refreshToken", true)]
    public void SecretNamesMatchWholeWords(string text, bool secret) =>
        Assert.Equal(secret, SendproofCommandInterceptor.LooksSecret(text));

    [Theory]
    [InlineData("Development", null, true)]
    [InlineData("Development", false, false)]
    [InlineData("Production", null, false)]
    [InlineData("Production", true, true)]
    public async Task CapturesReaderAndNonQueryCommandsWithScopedTimingAndRedactedValues(
        string environment, bool? configuredValues, bool showsSafeValue)
    {
        await using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();
        await using var app = await StartAsync(connection, environment, configuredValues);
        using var client = app.GetTestClient();

        using var ordinary = await client.PostAsync("/run", null);
        ordinary.EnsureSuccessStatusCode();
        Assert.False(ordinary.Headers.Contains("Server-Timing"));
        Assert.False(ordinary.Headers.Contains("X-Sendproof-Trace"));

        using var request = new HttpRequestMessage(HttpMethod.Post, "/sendproof/_preview/run");
        request.Headers.Add("Prefer", "tx=rollback");
        using var response = await client.SendAsync(request);
        response.EnsureSuccessStatusCode();
        Assert.Contains("db;dur=", Assert.Single(response.Headers.GetValues("Server-Timing")));
        Assert.Contains("desc=\"4 queries\"", Assert.Single(response.Headers.GetValues("Server-Timing")));

        var envelope = await response.Content.ReadFromJsonAsync<JsonElement>();
        var logs = envelope.GetProperty("logs").EnumerateArray().ToArray();
        var sqlLogs = logs.Where(log => log.GetProperty("level").GetString() == "Sql").ToArray();
        Assert.Equal(4, sqlLogs.Length);
        foreach (var log in sqlLogs)
        {
            Assert.Equal("Microsoft.EntityFrameworkCore.Database.Command", log.GetProperty("category").GetString());
            Assert.True(log.GetProperty("elapsedMs").GetDouble() >= 0);
            Assert.True(log.GetProperty("offsetMs").GetDouble() >= 0);
            Assert.True(log.GetProperty("eventId").GetProperty("id").GetInt32() > 0);
        }

        var sql = sqlLogs.Select(log => log.GetProperty("sql")).ToArray();
        Assert.All(sql.Take(2), entry => Assert.Equal(1, entry.GetProperty("rowsAffected").GetInt32()));
        Assert.Equal(showsSafeValue ? "safe-value" : "[REDACTED]", Parameter(sql[0], "$label").GetProperty("value").GetString());
        Assert.Equal("String", Parameter(sql[0], "$label").GetProperty("dbType").GetString());
        Assert.Equal("[REDACTED]", Parameter(sql[1], "$salt").GetProperty("value").GetString());
        Assert.Contains("PasswordHash", sql[2].GetProperty("text").GetString());
        var generated = Assert.Single(sql[2].GetProperty("parameters").EnumerateArray());
        Assert.Contains("filterValue", generated.GetProperty("name").GetString());
        Assert.Equal("[REDACTED]", generated.GetProperty("value").GetString());
        Assert.False(sql[2].TryGetProperty("rowsAffected", out _));

        var fullLogs = envelope.GetProperty("logs").GetRawText();
        Assert.DoesNotContain("secret-generated-value", fullLogs);
        Assert.DoesNotContain("secret-named-value", fullLogs);
        if (!showsSafeValue)
        {
            Assert.DoesNotContain("safe-value", fullLogs);
        }
        Assert.Equal(64, sql[3].GetProperty("parameters").GetArrayLength());
        Assert.Equal(4096, sql[3].GetProperty("text").GetString()!.Length);
        Assert.True(envelope.GetProperty("logsTruncated").GetBoolean());
    }

    [Fact]
    public async Task BoundedTrackedChangesDoNotLimitRollback()
    {
        await using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();
        await using var app = await StartAsync(connection, "Development", configuredValues: null);
        using var client = app.GetTestClient();
        using var request = new HttpRequestMessage(HttpMethod.Post, "/sendproof/_preview/changes");
        request.Headers.Add("Prefer", "tx=rollback");
        using var response = await client.SendAsync(request);
        response.EnsureSuccessStatusCode();
        var envelope = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(envelope.GetProperty("rolledBack").GetBoolean());
        Assert.True(envelope.GetProperty("changesTruncated").GetBoolean());
        Assert.Equal(200, envelope.GetProperty("changes").GetArrayLength());

        using var scope = app.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<CommandContext>();
        Assert.Equal(1, await db.Rows.CountAsync());
    }

    private static async Task<WebApplication> StartAsync(SqliteConnection connection, string environment, bool? configuredValues)
    {
        var builder = WebApplication.CreateBuilder(new WebApplicationOptions
        {
            EnvironmentName = environment,
            Args = ["--hostBuilder:reloadConfigOnChange=false"]
        });
        builder.WebHost.UseTestServer();
        builder.Logging.SetMinimumLevel(LogLevel.Information);
        builder.Services.AddDbContext<CommandContext>(options => options.UseSqlite(connection).EnableSensitiveDataLogging());
        var bench = builder.Services.AddSendproof().InEnvironments(environment).AddEntityFrameworkCore<CommandContext>();
        if (configuredValues is { } enabled)
        {
            bench.WithSqlParameterValues(enabled);
        }

        var app = builder.Build();
        using (var scope = app.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<CommandContext>();
            await db.Database.EnsureCreatedAsync();
            db.Rows.Add(new ProbeRow { Label = "initial", PasswordHash = "initial" });
            await db.SaveChangesAsync();
        }

        app.MapPost("/run", async (CommandContext db) =>
        {
            db.Database.ExecuteSqlRaw("UPDATE [Rows] SET Label = $label WHERE Id = 1", new SqliteParameter("$label", "safe-value"));
            await db.Database.ExecuteSqlRawAsync("UPDATE [Rows] SET Label = $salt WHERE Id = 1", new SqliteParameter("$salt", "secret-named-value"));

            var filterValue = "secret-generated-value";
            await db.Rows.Where(row => row.PasswordHash == filterValue).Select(row => row.Id).ToListAsync();

            var ids = Enumerable.Range(0, 70).Select(index => new SqliteParameter($"$val{index}", index)).ToArray();
            var placeholders = string.Join(',', ids.Select(parameter => parameter.ParameterName));
            var sql = "UPDATE [Rows] SET Label = 'end' WHERE Id IN (" + placeholders + ") -- " + new string('a', 5000);
            await db.Database.ExecuteSqlRawAsync(sql, ids);
            return Results.NoContent();
        }).WithSendproofPreview();
        app.MapPost("/changes", async (CommandContext db) =>
        {
            db.Rows.AddRange(Enumerable.Range(0, 205).Select(index => new ProbeRow { Label = $"Row {index}" }));
            await db.SaveChangesAsync();
            return Results.NoContent();
        }).WithSendproofPreview();
        app.MapSendproof();
        await app.StartAsync();
        return app;
    }

    private static JsonElement Parameter(JsonElement sql, string name) =>
        Assert.Single(sql.GetProperty("parameters").EnumerateArray(), parameter => parameter.GetProperty("name").GetString() == name);

    private sealed class CommandContext(DbContextOptions<CommandContext> options) : DbContext(options)
    {
        public DbSet<ProbeRow> Rows => Set<ProbeRow>();
    }

    private sealed class ProbeRow
    {
        public int Id { get; set; }
        public string Label { get; set; } = "";
        public string PasswordHash { get; set; } = "";
    }
}
