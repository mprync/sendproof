using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using MySql.Data.MySqlClient;
using Sendproof.AspNetCore;
using Sendproof.EntityFrameworkCore;
using Xunit;

namespace Sendproof.EntityFrameworkCore.Tests;

/// <summary>
/// MySQL Previews through the whole pipeline (compose MySQL service): a cancelled request still rolls back and hands the
/// Preview turn back, and a driver that inlines parameters into the SQL text never puts a secret in the logged statement.
/// </summary>
public sealed class MySqlPipelineTests
{
    private sealed class Gate
    {
        internal TaskCompletionSource Saved { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    }

    private static async Task<(WebApplication App, string Database)> StartAsync(Gate gate)
    {
        var root = ServiceFactAttribute.MySqlRoot;
        var name = "tb_ef_" + Guid.NewGuid().ToString("N")[..10];
        await using (var admin = new DbContext(new DbContextOptionsBuilder().UseMySQL(root).Options))
        {
            await admin.Database.ExecuteSqlRawAsync($"CREATE DATABASE {name}");
        }

        var builder = WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = "Development", Args = ["--hostBuilder:reloadConfigOnChange=false"] });
        builder.WebHost.UseTestServer();
        builder.Logging.SetMinimumLevel(LogLevel.Critical);
        builder.Services.AddDbContext<AccountsContext>(options => options.UseMySQL($"{root};database={name};Pooling=true"));
        builder.Services.AddSendproof().AddEntityFrameworkCore<AccountsContext>();
        var app = builder.Build();
        await using (var scope = app.Services.CreateAsyncScope())
        {
            await scope.ServiceProvider.GetRequiredService<AccountsContext>().Database.EnsureCreatedAsync();
        }

        app.MapPost("/accounts/{id}", async (string id, AccountsContext db, HttpContext context) =>
        {
            db.Accounts.Add(new Account { Id = id, PasswordHash = "hash-secret-" + id });
            await db.SaveChangesAsync();
            if (id.StartsWith("hang", StringComparison.Ordinal))
            {
                // Holds the Preview (its transaction and its MySQL turn) until the client goes away.
                gate.Saved.TrySetResult();
                await Task.Delay(Timeout.Infinite, context.RequestAborted);
            }

            // Inlined by the driver if it interpolates client-side; the value is secret-named, so it must stay redacted.
            var apiKey = "inline-secret-" + id;
            await db.Database.ExecuteSqlRawAsync("UPDATE Accounts SET PasswordHash = @password_hash WHERE Id = @id",
                new MySqlParameter("@password_hash", apiKey), new MySqlParameter("@id", id));
            return Results.Ok();
        }).WithSendproofPreview();
        app.MapSendproof();
        await app.StartAsync();
        return (app, name);
    }

    private static async Task DropAsync(WebApplication app, string name)
    {
        await app.DisposeAsync();
        await using var admin = new DbContext(new DbContextOptionsBuilder().UseMySQL(ServiceFactAttribute.MySqlRoot).Options);
        await admin.Database.ExecuteSqlRawAsync($"DROP DATABASE IF EXISTS {name}");
    }

    private static HttpRequestMessage Preview(string id)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, "/sendproof/_preview/accounts/" + id);
        request.Headers.Add("Prefer", "tx=rollback");
        return request;
    }

    [ServiceFact("mysql")]
    public async Task ACancelledPreviewRollsBackAndHandsTheMySqlTurnBack()
    {
        var gate = new Gate();
        var (app, name) = await StartAsync(gate);
        try
        {
            using var client = app.GetTestClient();
            using var cancel = new CancellationTokenSource();
            var hanging = client.SendAsync(Preview("hang-1"), cancel.Token);
            await gate.Saved.Task.WaitAsync(TimeSpan.FromSeconds(20));
            cancel.Cancel();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => hanging);

            // The next Preview needs the turn the cancelled one held: it only runs if cancellation ran the whole cleanup.
            using var next = await client.SendAsync(Preview("after")).WaitAsync(TimeSpan.FromSeconds(20));
            Assert.Equal(200, (int)next.StatusCode);
            await using var scope = app.Services.CreateAsyncScope();
            Assert.Empty(await scope.ServiceProvider.GetRequiredService<AccountsContext>().Accounts.ToListAsync());
        }
        finally
        {
            await DropAsync(app, name);
        }
    }

    [ServiceFact("mysql")]
    public async Task SecretValuesNeverAppearInTheLoggedStatementEvenWhenTheDriverInlinesThem()
    {
        var (app, name) = await StartAsync(new Gate());
        try
        {
            using var client = app.GetTestClient();
            using var response = await client.SendAsync(Preview("acct-1"));
            var body = await response.Content.ReadAsStringAsync();
            Assert.True(response.IsSuccessStatusCode, body);
            Assert.DoesNotContain("hash-secret-acct-1", body);
            Assert.DoesNotContain("inline-secret-acct-1", body);
            var envelope = JsonDocument.Parse(body).RootElement;
            var update = Assert.Single(envelope.GetProperty("logs").EnumerateArray(), entry =>
                entry.GetProperty("level").GetString() == "Sql" && entry.GetProperty("sql").GetProperty("text").GetString()!.StartsWith("UPDATE Accounts", StringComparison.Ordinal));
            Assert.Contains("@password_hash", update.GetProperty("sql").GetProperty("text").GetString());
            var parameter = Assert.Single(update.GetProperty("sql").GetProperty("parameters").EnumerateArray(), item => item.GetProperty("name").GetString() == "@password_hash");
            Assert.Equal("[REDACTED]", parameter.GetProperty("value").GetString());
        }
        finally
        {
            await DropAsync(app, name);
        }
    }

    public sealed class AccountsContext(DbContextOptions<AccountsContext> options) : DbContext(options)
    {
        public DbSet<Account> Accounts => Set<Account>();
    }

    public sealed class Account
    {
        public string Id { get; set; } = "";
        public string PasswordHash { get; set; } = "";
    }
}
