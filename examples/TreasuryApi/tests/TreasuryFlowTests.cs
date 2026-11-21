using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using TreasuryApi;
using Xunit;

public sealed class TreasuryFlowTests
{
    private const string OperatingEur = "3f9c0000-0000-4000-8000-00000000a21e";
    private const string Northwind = "5b7c0000-0000-4000-8000-00000000b123";

    [Fact]
    public async Task Authentication_preview_send_validation_and_switch_use_real_sqlite()
    {
        await using var host = await TreasuryHost.StartAsync();
        var (app, client) = (host.App, host.Client);
        Assert.Contains("app.js", await client.GetStringAsync("/bench/"));
        Assert.Contains("--accent", await client.GetStringAsync("/bench/styles.css"));
        Assert.Contains("flask", await client.GetStringAsync("/bench/icons.js"));
        Assert.Contains("export", await client.GetStringAsync("/bench/fields/render.js"));
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync("/bench/package.json")).StatusCode);
        var request = new CreatePaymentRequest
        {
            DebitAccountId = Guid.Parse(OperatingEur),
            CounterpartyId = Guid.Parse(Northwind),
            Amount = 50000m, Currency = "EUR", ValueDate = DateOnly.FromDateTime(DateTime.UtcNow.AddDays(3)),
            Priority = "Normal", Reference = "INV-2026-1184"
        };
        Assert.Equal(HttpStatusCode.Unauthorized, (await Preview(client, request)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.PostAsJsonAsync("/auth/login", new { email = "ada.admin@acme.dev", password = "wrong" })).StatusCode);
        var login = await client.PostAsJsonAsync("/auth/login", new { email = "ada.admin@acme.dev", password = "Demo123!" });
        Assert.Equal(HttpStatusCode.OK, login.StatusCode);
        host.SetCookie(login);
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/api/v2/accounts")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/api/v2/counterparties")).StatusCode);

        // The seeded database already holds payments, so every count below is relative to this baseline.
        var baseline = await Counts(app);
        Assert.True(baseline.Payments >= 150, "The seed provides a realistic number of payments.");

        var spec = await client.GetStringAsync("/openapi/v1.json");
        using (var document = JsonDocument.Parse(spec))
        {
            var schemas = document.RootElement.GetProperty("components").GetProperty("schemas");
            var paymentSchema = schemas.GetProperty("CreatePaymentRequest");
            var example = paymentSchema.GetProperty("examples")[0];
            var required = paymentSchema.GetProperty("required").EnumerateArray().Select(value => value.GetString()).ToArray();
            Assert.Contains("amount", required);
            // The workbench explains sign-in, roles and failures from the documented security and responses.
            var create = document.RootElement.GetProperty("paths").GetProperty("/api/v2/payments").GetProperty("post");
            Assert.Equal("PaymentsController.Create", create.GetProperty("operationId").GetString());
            Assert.Equal(2, create.GetProperty("security").GetArrayLength());
            Assert.True(create.GetProperty("responses").TryGetProperty("401", out _));
            Assert.True(create.GetProperty("responses").TryGetProperty("403", out _));
            Assert.Equal("cookie", document.RootElement.GetProperty("components").GetProperty("securitySchemes")
                .GetProperty("cookieAuth").GetProperty("in").GetString());
            Assert.Contains("valueDate", required);
            Assert.DoesNotContain("priority", required);
            var properties = paymentSchema.GetProperty("properties");
            Assert.Equal("Debit account", properties.GetProperty("debitAccountId").GetProperty("title").GetString());
            Assert.Equal("payment-details", properties.GetProperty("amount").GetProperty("x-testbench-row").GetString());
            Assert.True(properties.GetProperty("priority").GetProperty("x-testbench-visible").GetBoolean());
            var examplePreview = await Preview(client, example);
            var exampleResponse = await examplePreview.Content.ReadAsStringAsync();
            Assert.True(examplePreview.IsSuccessStatusCode, exampleResponse);
            using var result = JsonDocument.Parse(exampleResponse);
            Assert.Equal(201, result.RootElement.GetProperty("status").GetInt32());
            Assert.True(result.RootElement.GetProperty("rolledBack").GetBoolean());
        }
        await AssertDatabase(app, baseline, 0, 250000m, 0);

        var preview = await Preview(client, request);
        var previewText = await preview.Content.ReadAsStringAsync();
        Assert.True(preview.IsSuccessStatusCode, previewText);
        using (var json = JsonDocument.Parse(previewText))
        {
            Assert.True(json.RootElement.GetProperty("rolledBack").GetBoolean());
            Assert.Equal(201, json.RootElement.GetProperty("status").GetInt32());
            Assert.NotEmpty(json.RootElement.GetProperty("changes").EnumerateArray());
            var effect = Assert.Single(json.RootElement.GetProperty("effects").EnumerateArray());
            Assert.Equal("email", effect.GetProperty("kind").GetString());
            Assert.False(effect.TryGetProperty("delivered", out _));
            Assert.Equal("treasury-ops@acme.dev", effect.GetProperty("data").GetProperty("to")[0].GetString());
            Assert.Contains(json.RootElement.GetProperty("logs").EnumerateArray(), log => log.GetProperty("level").GetString() == "Sql");
            Assert.Contains("db;dur=", Assert.Single(preview.Headers.GetValues("Server-Timing")));
        }
        await AssertDatabase(app, baseline, 0, 250000m, 0);

        request.Amount = 0;
        var invalid = await client.PostAsJsonAsync("/api/v2/payments", request);
        Assert.Equal(HttpStatusCode.BadRequest, invalid.StatusCode);
        request.Amount = 50000m;
        using var send = new HttpRequestMessage(HttpMethod.Post, "/api/v2/payments") { Content = JsonContent.Create(request) };
        send.Headers.Add("Idempotency-Key", "test-payment-1");
        send.Headers.Add("Prefer", "trace");
        using var sent = await client.SendAsync(send);
        Assert.Equal(HttpStatusCode.Created, sent.StatusCode);
        Assert.Contains("db;dur=", Assert.Single(sent.Headers.GetValues("Server-Timing")));
        Assert.True(sent.Headers.Location is not null);
        var traceUrl = "/bench/_api/traces/" + Assert.Single(sent.Headers.GetValues("X-TestBench-Trace"));
        var trace = await client.GetFromJsonAsync<JsonElement>(traceUrl);
        Assert.Contains(trace.GetProperty("changes").EnumerateArray(), change => change.GetProperty("operation").GetString() == "insert");
        Assert.True(Assert.Single(trace.GetProperty("effects").EnumerateArray()).GetProperty("delivered").GetBoolean());
        var sql = trace.GetProperty("logs").EnumerateArray().Count(log => log.GetProperty("level").GetString() == "Sql");
        Assert.True(sql > 0);
        Assert.Equal(sql, trace.GetProperty("timing").GetProperty("queryCount").GetInt32());
        await AssertDatabase(app, baseline, 1, 200000m, 1);
        using var retry = new HttpRequestMessage(HttpMethod.Post, "/api/v2/payments") { Content = JsonContent.Create(request) };
        retry.Headers.Add("Idempotency-Key", "test-payment-1");
        Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(retry)).StatusCode);
        await AssertDatabase(app, baseline, 1, 200000m, 1);
        request.Amount = 1;
        using var conflict = new HttpRequestMessage(HttpMethod.Post, "/api/v2/payments") { Content = JsonContent.Create(request) };
        conflict.Headers.Add("Idempotency-Key", "test-payment-1");
        Assert.Equal(HttpStatusCode.Conflict, (await client.SendAsync(conflict)).StatusCode);

        // A sent payment can be found again by its reference, which is how the browser test checks it.
        var found = await client.GetFromJsonAsync<JsonElement>("/api/v2/payments?reference=INV-2026-1184");
        Assert.Equal(1, found.GetProperty("totalItems").GetInt32());

        var switchUser = await client.PostAsync("/auth/personas/cara.viewer%40acme.dev", null);
        Assert.Equal(HttpStatusCode.OK, switchUser.StatusCode);
        host.SetCookie(switchUser);
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync(traceUrl)).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await Preview(client, request)).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.PostAsJsonAsync("/api/v2/payments", request)).StatusCode);
        await AssertDatabase(app, baseline, 1, 200000m, 1);

        Assert.Contains("x-lookup", spec);
        Assert.Contains("x-currency-field", spec);
        Assert.Contains("/api/v2/payments", spec);
    }

    /// <summary>The deprecated balance operation publishes its replacements and sunset date, and sends the Sunset header.</summary>
    [Fact]
    public async Task Deprecated_balance_publishes_replacements_and_sunset_and_enums_publish_descriptions()
    {
        await using var host = await TreasuryHost.StartAsync();
        using var document = JsonDocument.Parse(await host.Client.GetStringAsync("/openapi/v1.json"));
        var root = document.RootElement;
        var legacy = root.GetProperty("paths").GetProperty("/api/v2/accounts/{id}/balance").GetProperty("get");
        Assert.Equal("2027-06-30", legacy.GetProperty("x-sunset").GetString());
        var replacements = legacy.GetProperty("x-replaced-by").EnumerateArray().ToList();
        Assert.Equal(2, replacements.Count);
        Assert.Equal("BalancesController.Get", replacements[0].GetProperty("operationId").GetString());
        Assert.Equal("$request.path.id", replacements[0].GetProperty("parameters").GetProperty("accountId").GetString());
        Assert.Equal("BalancesController.List", replacements[1].GetProperty("operationId").GetString());

        var schemas = root.GetProperty("components").GetProperty("schemas");
        foreach (var name in new[] { "AccountStatus", "AccountType", "Currency", "Priority", "PaymentStatus" })
            Assert.True(schemas.GetProperty(name).TryGetProperty("x-enum-descriptions", out _), $"{name} has x-enum-descriptions");
        Assert.Equal("Settles today if sent before the bank’s cut-off.", schemas.GetProperty("Priority").GetProperty("x-enum-descriptions").GetProperty("Same day").GetString());
        var request = schemas.GetProperty("CreatePaymentRequest").GetProperty("properties");
        Assert.Equal("Euro", request.GetProperty("currency").GetProperty("x-enum-descriptions").GetProperty("EUR").GetString());
        Assert.True(request.GetProperty("priority").GetProperty("x-enum-descriptions").TryGetProperty("Same day", out _));
        var sort = root.GetProperty("paths").GetProperty("/api/v2/accounts").GetProperty("get").GetProperty("parameters").EnumerateArray()
            .Single(parameter => parameter.GetProperty("name").GetString() == "sort").GetProperty("schema");
        Assert.Equal("Opened, newest first", sort.GetProperty("x-enum-descriptions").GetProperty("-openedOn").GetString());

        await host.SignInAsync("ada.admin@acme.dev");
        var account = (await host.Client.GetFromJsonAsync<JsonElement>("/api/v2/accounts?pageSize=1")).GetProperty("items")[0].GetProperty("id").GetString();
        var response = await host.Client.GetAsync($"/api/v2/accounts/{account}/balance");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("Wed, 30 Jun 2027 00:00:00 GMT", response.Headers.GetValues("Sunset").Single());
        Assert.Equal("true", response.Headers.GetValues("Deprecation").Single());
    }

    [Fact]
    public async Task Approval_flow_enforces_four_eyes_and_every_write_previews_without_persisting()
    {
        await using var host = await TreasuryHost.StartAsync();
        var client = host.Client;
        await host.SignInAsync("tomas.treasurer@acme.dev");
        var request = new CreatePaymentRequest
        {
            DebitAccountId = Guid.Parse(OperatingEur), CounterpartyId = Guid.Parse(Northwind), Amount = 1200.50m, Currency = "EUR",
            ValueDate = DateOnly.FromDateTime(DateTime.UtcNow.AddDays(2)), Reference = "approval-flow"
        };
        var created = await (await client.PostAsJsonAsync("/api/v2/payments", request)).Content.ReadFromJsonAsync<JsonElement>();
        var id = created.GetProperty("id").GetString();
        Assert.Equal("Draft", created.GetProperty("status").GetString());

        // Submitting is previewable and writes nothing; the real submit moves the payment to PendingApproval.
        var submitPreview = await PreviewJson<object>(client, $"/api/v2/payments/{id}/submit", null);
        Assert.Equal(200, submitPreview.GetProperty("status").GetInt32());
        Assert.Equal("email", Assert.Single(submitPreview.GetProperty("effects").EnumerateArray()).GetProperty("kind").GetString());
        Assert.Equal("Draft", (await GetPayment(client, id!)).GetProperty("status").GetString());
        Assert.Equal(HttpStatusCode.OK, (await client.PostAsync($"/api/v2/payments/{id}/submit", null)).StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, (await client.PostAsync($"/api/v2/payments/{id}/submit", null)).StatusCode);

        // The creator cannot approve their own payment, and a read-only user cannot approve at all.
        var self = await client.PostAsJsonAsync($"/api/v2/approvals/{id}/approve", new { });
        Assert.Equal(HttpStatusCode.Forbidden, self.StatusCode);
        Assert.Contains("Four-eyes", await self.Content.ReadAsStringAsync());
        await host.SignInAsync("cara.viewer@acme.dev");
        Assert.Equal(HttpStatusCode.Forbidden, (await client.PostAsJsonAsync($"/api/v2/approvals/{id}/approve", new { })).StatusCode);

        await host.SignInAsync("ben.approver@acme.dev");
        var queue = await client.GetFromJsonAsync<JsonElement>("/api/v2/approvals?pageSize=100");
        var row = queue.GetProperty("items").EnumerateArray().Single(item => item.GetProperty("paymentId").GetString() == id);
        Assert.True(row.GetProperty("canApprove").GetBoolean());
        var approvePreview = await PreviewJson(client, $"/api/v2/approvals/{id}/approve", new { comment = "ok" });
        Assert.Equal(200, approvePreview.GetProperty("status").GetInt32());
        Assert.NotEmpty(approvePreview.GetProperty("effects").EnumerateArray());
        Assert.Equal("PendingApproval", (await GetPayment(client, id!)).GetProperty("status").GetString());
        var short1 = await client.PostAsJsonAsync($"/api/v2/approvals/{id}/reject", new { reason = "no" });
        Assert.Equal(HttpStatusCode.BadRequest, short1.StatusCode);
        var rejected = await client.PostAsJsonAsync($"/api/v2/approvals/{id}/reject", new { reason = "Amount does not match the invoice." });
        Assert.Equal(HttpStatusCode.OK, rejected.StatusCode);
        var rejectedPayment = await GetPayment(client, id!);
        Assert.Equal("Rejected", rejectedPayment.GetProperty("status").GetString());
        Assert.Equal("Rejected", rejectedPayment.GetProperty("approvals")[0].GetProperty("decision").GetString());
        var accounts = await client.GetFromJsonAsync<JsonElement>("/api/v2/accounts?pageSize=100");
        Assert.Equal(250000m, accounts.GetProperty("items").EnumerateArray()
            .Single(account => account.GetProperty("name").GetString() == "Operating EUR").GetProperty("availableBalance").GetDecimal());

        // A rejected payment can be revised, submitted again and then cancelled.
        await host.SignInAsync("tomas.treasurer@acme.dev");
        var revised = await client.PutAsJsonAsync($"/api/v2/payments/{id}", new UpdatePaymentRequest
        {
            CounterpartyId = Guid.Parse(Northwind), Amount = 1100m, ValueDate = request.ValueDate, Reference = "approval-flow v2"
        });
        Assert.Equal(HttpStatusCode.OK, revised.StatusCode);
        Assert.Equal("Draft", (await GetPayment(client, id!)).GetProperty("status").GetString());
        var cancelled = await client.PostAsync($"/api/v2/payments/{id}/cancel", null);
        Assert.Equal(HttpStatusCode.OK, cancelled.StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, (await client.PostAsync($"/api/v2/payments/{id}/cancel", null)).StatusCode);

        // The other meaningful writes preview with their effects and keep nothing.
        var before = await Counts(host.App);
        var counterparty = await PreviewJson(client, "/api/v2/counterparties", new
        {
            name = "Preview Supplies Ltd", type = "Supplier", country = "IE", address = new { line = "1 Main Street", city = "Cork" },
            bankDetails = new { scheme = "Iban", iban = "IE29AIBK93115212345678" }
        });
        Assert.Equal(201, counterparty.GetProperty("status").GetInt32());
        Assert.Contains(counterparty.GetProperty("effects").EnumerateArray(), effect => effect.GetProperty("kind").GetString() == "job");
        var quote = await (await client.PostAsJsonAsync("/api/v2/fx/quotes", new { pair = "EURUSD", side = "Buy", type = "Spot", baseAmount = 100000 }))
            .Content.ReadFromJsonAsync<JsonElement>();
        var deal = await PreviewJson(client, "/api/v2/fx/deals", new { pair = "EURUSD", side = "Buy", type = "Spot", baseAmount = 100000, rate = quote.GetProperty("rate").GetDecimal() });
        Assert.Equal(201, deal.GetProperty("status").GetInt32());
        Assert.Equal("Spot", deal.GetProperty("body").GetProperty("type").GetString());
        Assert.Contains(deal.GetProperty("effects").EnumerateArray(), effect => effect.GetProperty("kind").GetString() == "message");
        await host.SignInAsync("ada.admin@acme.dev");
        var role = await PreviewJson(client, "/api/v2/users/2/role", new { role = "read-only" }, HttpMethod.Put);
        Assert.Equal(200, role.GetProperty("status").GetInt32());
        Assert.NotEmpty(role.GetProperty("changes").EnumerateArray());
        var users = await client.GetFromJsonAsync<JsonElement>("/api/v2/users/2");
        Assert.Equal("payments.approve", users.GetProperty("role").GetString());
        var after = await Counts(host.App);
        Assert.Equal(before.Counterparties, after.Counterparties);
        Assert.Equal(before.FxDeals, after.FxDeals);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await client.PutAsJsonAsync("/api/v2/users/1/role", new { role = "read-only" })).StatusCode);
    }

    [Fact]
    public async Task Seed_data_is_realistic_checksum_valid_and_reconciles()
    {
        await using var host = await TreasuryHost.StartAsync();
        var client = host.Client;
        await host.SignInAsync("ada.admin@acme.dev");

        var accounts = await ReadAll(client, "/api/v2/accounts");
        Assert.InRange(accounts.Count, 20, 30);
        Assert.All(accounts, account => Assert.True(IsValidIban(account.GetProperty("iban").GetString()!), account.GetProperty("name").GetString()));
        Assert.All(accounts, account => Assert.Matches("^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$", account.GetProperty("bic").GetString()!));
        Assert.Equal(new HashSet<string> { "EUR", "USD", "GBP", "CHF", "SEK", "JPY" },
            accounts.Select(account => account.GetProperty("currency").GetString()!).ToHashSet());
        var operating = accounts.Single(account => account.GetProperty("name").GetString() == "Operating EUR");
        Assert.Equal(OperatingEur, operating.GetProperty("id").GetString());
        Assert.Equal(250000m, operating.GetProperty("availableBalance").GetDecimal());
        Assert.Equal(250000m, operating.GetProperty("ledgerBalance").GetDecimal());
        Assert.All(accounts, account => Assert.True(account.GetProperty("availableBalance").GetDecimal() >= 0));
        Assert.Contains(accounts, account => account.GetProperty("status").GetString() == "Closed");
        Assert.Contains(accounts, account => account.GetProperty("status").GetString() == "Frozen");

        var counterparties = await ReadAll(client, "/api/v2/counterparties");
        Assert.InRange(counterparties.Count, 40, 60);
        Assert.Contains(counterparties, c => c.GetProperty("id").GetString() == Northwind && c.GetProperty("name").GetString() == "Northwind Logistics GmbH");
        Assert.Equal(new HashSet<string> { "Iban", "UsAch", "Swift" },
            counterparties.Select(c => c.GetProperty("bankDetails").GetProperty("scheme").GetString()!).ToHashSet());
        Assert.All(counterparties.Where(c => c.GetProperty("bankDetails").GetProperty("scheme").GetString() == "Iban"),
            c => Assert.True(IsValidIban(c.GetProperty("bankDetails").GetProperty("iban").GetString()!), c.GetProperty("name").GetString()));

        var payments = await ReadAll(client, "/api/v2/payments");
        Assert.InRange(payments.Count, 150, 250);
        var statuses = payments.Select(p => p.GetProperty("status").GetString()!).ToHashSet();
        Assert.Equal(Enum.GetNames<PaymentStatus>().ToHashSet(), statuses);
        Assert.Contains(payments, p => p.GetProperty("amount").GetDecimal() % 1 != 0);
        Assert.Contains(payments, p => p.GetProperty("approvals").GetArrayLength() > 0);
        Assert.Equal(payments.Count, payments.Select(p => p.GetProperty("number").GetString()).Distinct().Count());
        var today = DateOnly.FromDateTime(DateTime.UtcNow);
        var dates = payments.Select(p => DateOnly.Parse(p.GetProperty("valueDate").GetString()!)).ToList();
        Assert.InRange(today.DayNumber - dates.Min().DayNumber, 60, 100);
        Assert.InRange(dates.Max().DayNumber - today.DayNumber, 10, 31);
        // Operating EUR keeps its exact balance, so it carries only finished payments.
        Assert.DoesNotContain(payments, p => p.GetProperty("debitAccount").GetProperty("id").GetString() == OperatingEur &&
            p.GetProperty("status").GetString() is "Draft" or "PendingApproval" or "Approved" or "Scheduled");

        var fx = await ReadAll(client, "/api/v2/fx/deals");
        Assert.InRange(fx.Count, 25, 40);
        Assert.Equal(new HashSet<string> { "Spot", "Forward" }, fx.Select(d => d.GetProperty("type").GetString()!).ToHashSet());
        Assert.All(fx.Where(d => d.GetProperty("type").GetString() == "Forward"), d => Assert.True(d.TryGetProperty("forwardPoints", out _)));

        // Every statement reconciles, and the days chain: one day's closing balance is the next day's opening balance.
        var statements = await ReadAll(client, "/api/v2/bank-statements");
        Assert.NotEmpty(statements);
        foreach (var group in statements.GroupBy(s => s.GetProperty("account").GetProperty("id").GetString()))
        {
            var ordered = group.OrderBy(s => s.GetProperty("statementDate").GetString(), StringComparer.Ordinal).ToList();
            for (var i = 1; i < ordered.Count; i++)
                Assert.Equal(ordered[i - 1].GetProperty("closingBalance").GetProperty("value").GetDecimal(),
                    ordered[i].GetProperty("openingBalance").GetProperty("value").GetDecimal());
        }
        var sample = statements.First(s => s.GetProperty("account").GetProperty("id").GetString() == OperatingEur);
        var detail = await client.GetFromJsonAsync<JsonElement>("/api/v2/bank-statements/" + sample.GetProperty("id").GetString());
        var net = detail.GetProperty("entries").EnumerateArray().Sum(e => e.GetProperty("type").GetString() is "Credit" or "Interest"
            ? e.GetProperty("amount").GetProperty("value").GetDecimal() : -e.GetProperty("amount").GetProperty("value").GetDecimal());
        Assert.Equal(detail.GetProperty("openingBalance").GetProperty("value").GetDecimal() + net,
            detail.GetProperty("closingBalance").GetProperty("value").GetDecimal());
        var newest = statements.Where(s => s.GetProperty("account").GetProperty("id").GetString() == OperatingEur)
            .OrderByDescending(s => s.GetProperty("statementDate").GetString(), StringComparer.Ordinal).First();
        Assert.Equal(250000m, newest.GetProperty("closingBalance").GetProperty("value").GetDecimal());

        var users = await client.GetFromJsonAsync<JsonElement>("/api/v2/users?pageSize=100");
        var emails = users.GetProperty("items").EnumerateArray().Select(u => u.GetProperty("email").GetString()!).ToList();
        Assert.Contains("ada.admin@acme.dev", emails);
        Assert.Contains("ben.approver@acme.dev", emails);
        Assert.Contains("cara.viewer@acme.dev", emails);
        Assert.True(emails.Count >= 6);
    }

    [Fact]
    public async Task OpenApi_document_describes_every_operation_parameter_and_property()
    {
        await using var host = await TreasuryHost.StartAsync();
        using var document = JsonDocument.Parse(await host.Client.GetStringAsync("/openapi/v1.json"));
        var root = document.RootElement;
        var schemas = root.GetProperty("components").GetProperty("schemas");
        var problems = new List<string>();

        Assert.StartsWith("3.1", root.GetProperty("openapi").GetString());
        Assert.False(string.IsNullOrWhiteSpace(root.GetProperty("info").GetProperty("description").GetString()));
        Assert.True(root.GetProperty("info").GetProperty("description").GetString()!.Length > 500, "A few paragraphs of narrative");
        Assert.True(root.GetProperty("info").TryGetProperty("contact", out _));
        Assert.True(root.GetProperty("info").TryGetProperty("license", out _));

        var tags = root.GetProperty("tags").EnumerateArray().ToList();
        Assert.True(tags.Count >= 8);
        foreach (var tag in tags)
            if (string.IsNullOrWhiteSpace(tag.TryGetProperty("description", out var text) ? text.GetString() : null))
                problems.Add($"tag {tag.GetProperty("name").GetString()} has no description");
        var tagNames = tags.Select(tag => tag.GetProperty("name").GetString()).ToHashSet();

        var operations = 0;
        var secured = 0;
        var deprecated = 0;
        var operationIds = new HashSet<string>();
        foreach (var path in root.GetProperty("paths").EnumerateObject())
            foreach (var operation in path.Value.EnumerateObject())
            {
                operations++;
                var name = $"{operation.Name.ToUpperInvariant()} {path.Name}";
                var body = operation.Value;
                if (IsBlank(body, "summary")) problems.Add($"{name} has no summary");
                if (IsBlank(body, "description")) problems.Add($"{name} has no description");
                if (!operationIds.Add(body.GetProperty("operationId").GetString()!)) problems.Add($"{name} repeats an operationId");
                foreach (var tag in body.GetProperty("tags").EnumerateArray())
                    if (!tagNames.Contains(tag.GetString())) problems.Add($"{name} uses undeclared tag {tag.GetString()}");
                if (body.TryGetProperty("security", out var security) && security.GetArrayLength() > 0) secured++;
                if (body.TryGetProperty("deprecated", out var flag) && flag.GetBoolean()) deprecated++;
                if (body.TryGetProperty("parameters", out var parameters))
                    foreach (var parameter in parameters.EnumerateArray().Where(p => IsBlank(p, "description")))
                        problems.Add($"{name} parameter {parameter.GetProperty("name").GetString()} has no description");
                if (body.TryGetProperty("requestBody", out var requestBody) && IsBlank(requestBody, "description"))
                    problems.Add($"{name} request body has no description");
                foreach (var response in body.GetProperty("responses").EnumerateObject().Where(r => IsBlank(r.Value, "description")))
                    problems.Add($"{name} response {response.Name} has no description");
            }

        foreach (var schema in schemas.EnumerateObject())
        {
            if (IsBlank(schema.Value, "description")) problems.Add($"schema {schema.Name} has no description");
            if (!schema.Value.TryGetProperty("properties", out var properties)) continue;
            foreach (var property in properties.EnumerateObject())
            {
                var value = property.Value;
                // A reference or optional reference carries its description beside the $ref, or inside the oneOf.
                var described = !IsBlank(value, "description") ||
                    (value.TryGetProperty("oneOf", out var alternatives) && alternatives.EnumerateArray().Any(a => !IsBlank(a, "description")));
                if (!described) problems.Add($"schema {schema.Name}.{property.Name} has no description");
            }
        }

        Assert.True(operations is >= 30 and <= 40, $"{operations} operations");
        Assert.True(secured >= 30, "Most operations need sign-in");
        Assert.True(deprecated >= 1, "At least one operation is deprecated");
        // At least one discriminated union, documented as oneOf with a mapping, and with runtime JSON that matches it.
        var unions = schemas.EnumerateObject().Where(s => s.Value.TryGetProperty("discriminator", out _)).ToList();
        Assert.True(unions.Count >= 2, "Counterparty bank details and FX deals are discriminated unions");
        foreach (var union in unions)
        {
            Assert.True(union.Value.TryGetProperty("oneOf", out _), $"{union.Name} is a oneOf");
            Assert.True(union.Value.GetProperty("discriminator").TryGetProperty("mapping", out _), $"{union.Name} maps its variants");
        }
        // Constraints and formats the workbench relies on.
        var request = schemas.GetProperty("CreatePaymentRequest").GetProperty("properties");
        Assert.Equal(35, request.GetProperty("reference").GetProperty("maxLength").GetInt32());
        Assert.Equal(4, request.GetProperty("remittanceLines").GetProperty("maxItems").GetInt32());
        Assert.Equal("date", request.GetProperty("valueDate").GetProperty("format").GetString());
        Assert.Equal("uuid", request.GetProperty("debitAccountId").GetProperty("format").GetString());
        Assert.Equal(0.01m, request.GetProperty("amount").GetProperty("multipleOf").GetDecimal());
        Assert.Contains("ProblemDetails", schemas.EnumerateObject().Select(s => s.Name));
        Assert.Contains("HttpValidationProblemDetails", schemas.EnumerateObject().Select(s => s.Name));
        var page = schemas.GetProperty("PagedListOfPayment").GetProperty("required").EnumerateArray().Select(v => v.GetString()).ToList();
        Assert.Equal(new[] { "items", "page", "pageSize", "totalItems", "totalPages" }, page.ToArray());
        var list = root.GetProperty("paths").GetProperty("/api/v2/payments").GetProperty("get").GetProperty("parameters").EnumerateArray().ToList();
        var pageSize = list.Single(p => p.GetProperty("name").GetString() == "pageSize").GetProperty("schema");
        Assert.Equal((1, 100, 25), (pageSize.GetProperty("minimum").GetInt32(), pageSize.GetProperty("maximum").GetInt32(), pageSize.GetProperty("default").GetInt32()));
        Assert.Contains("-amount", list.Single(p => p.GetProperty("name").GetString() == "sort").GetProperty("schema").GetProperty("enum")
            .EnumerateArray().Select(v => v.GetString()));
        Assert.Empty(problems);
    }

    [Fact]
    public void Cookie_keys_live_beside_the_demo_database()
    {
        var database = Path.Combine(Path.GetTempPath(), "treasury-demo.db");
        Assert.Equal(Path.Combine(Path.GetTempPath(), "treasury-demo.keys"), TreasuryApplication.DefaultKeyDirectory(database));
    }

    private static bool IsBlank(JsonElement element, string property) =>
        !element.TryGetProperty(property, out var value) || string.IsNullOrWhiteSpace(value.GetString());

    /// <summary>ISO 7064 mod 97-10 check of an IBAN, independent of the application's own implementation.</summary>
    private static bool IsValidIban(string iban)
    {
        var compact = iban.Replace(" ", "").ToUpperInvariant();
        var rearranged = compact[4..] + compact[..4];
        var remainder = 0;
        foreach (var digit in string.Concat(rearranged.Select(c => char.IsLetter(c) ? (c - 'A' + 10).ToString() : c.ToString())))
            remainder = (remainder * 10 + (digit - '0')) % 97;
        return remainder == 1;
    }

    private static async Task<List<JsonElement>> ReadAll(HttpClient client, string path)
    {
        var items = new List<JsonElement>();
        for (var page = 1; ; page++)
        {
            var result = await client.GetFromJsonAsync<JsonElement>($"{path}?pageSize=100&page={page}");
            items.AddRange(result.GetProperty("items").EnumerateArray().Select(item => item.Clone()));
            if (page >= result.GetProperty("totalPages").GetInt32()) return items;
        }
    }

    private static async Task<JsonElement> GetPayment(HttpClient client, string id) =>
        await client.GetFromJsonAsync<JsonElement>($"/api/v2/payments/{id}");

    private static Task<HttpResponseMessage> Preview<T>(HttpClient client, T request) => PreviewResponse(client, "/api/v2/payments", request, HttpMethod.Post);

    private static async Task<HttpResponseMessage> PreviewResponse<T>(HttpClient client, string path, T? body, HttpMethod method)
    {
        using var message = new HttpRequestMessage(method, "/bench/_preview" + path);
        if (body is not null) message.Content = JsonContent.Create(body);
        message.Headers.Add("Prefer", "tx=rollback");
        return await client.SendAsync(message);
    }

    /// <summary>Runs an operation in Preview and returns the confirmed envelope after checking that it rolled back.</summary>
    private static async Task<JsonElement> PreviewJson<T>(HttpClient client, string path, T? body, HttpMethod? method = null)
    {
        using var response = await PreviewResponse(client, path, body, method ?? HttpMethod.Post);
        var text = await response.Content.ReadAsStringAsync();
        Assert.True(response.IsSuccessStatusCode, text);
        var envelope = JsonDocument.Parse(text).RootElement.Clone();
        Assert.True(envelope.GetProperty("rolledBack").GetBoolean());
        return envelope;
    }

    private sealed record Totals(int Payments, int Audit, int Counterparties, int FxDeals);

    private static async Task<Totals> Counts(WebApplication app)
    {
        using var scope = app.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<TreasuryDbContext>();
        return new Totals(await db.Payments.CountAsync(), await db.AuditEvents.CountAsync(), await db.Counterparties.CountAsync(), await db.FxDeals.CountAsync());
    }

    /// <summary>Asserts the persisted state: <paramref name="added"/> payments (and audit events) beyond the seeded baseline.</summary>
    private static async Task AssertDatabase(WebApplication app, Totals baseline, int added, decimal balance, int notifications)
    {
        using var scope = app.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<TreasuryDbContext>();
        Assert.Equal(baseline.Payments + added, await db.Payments.CountAsync());
        Assert.Equal(baseline.Audit + added, await db.AuditEvents.CountAsync());
        Assert.Equal(balance, (await db.Accounts.SingleAsync(a => a.Name == "Operating EUR")).AvailableBalance);
        Assert.Equal(notifications, app.Services.GetRequiredService<DemoNotificationQueue>().Messages.Count);
    }

    /// <summary>A started Treasury application on an in-memory test server with a new temporary SQLite database.</summary>
    private sealed class TreasuryHost : IAsyncDisposable
    {
        private readonly string _path;
        private TreasuryHost(string path, WebApplication app) { _path = path; App = app; Client = app.GetTestClient(); }

        public WebApplication App { get; }
        public HttpClient Client { get; }

        public static async Task<TreasuryHost> StartAsync()
        {
            var path = Path.Combine(Path.GetTempPath(), $"treasury-test-{Guid.NewGuid():N}.db");
            var builder = WebApplication.CreateBuilder(new WebApplicationOptions
            {
                EnvironmentName = "Development", ApplicationName = typeof(TreasuryApplication).Assembly.FullName,
                Args = ["--hostBuilder:reloadConfigOnChange=false"]
            });
            builder.Services.AddDataProtection().UseEphemeralDataProtectionProvider();
            builder.Configuration["DemoDatabasePath"] = path;
            builder.WebHost.UseTestServer();
            var app = await TreasuryApplication.BuildAsync(builder);
            await app.StartAsync();
            return new TreasuryHost(path, app);
        }

        /// <summary>Switches the client to a seeded user, like the workbench's persona picker.</summary>
        public async Task SignInAsync(string email) =>
            SetCookie(await Client.PostAsync("/auth/personas/" + Uri.EscapeDataString(email), null));

        public void SetCookie(HttpResponseMessage response)
        {
            Assert.True(response.IsSuccessStatusCode, response.StatusCode.ToString());
            var cookie = response.Headers.GetValues("Set-Cookie").Single().Split(';')[0];
            Client.DefaultRequestHeaders.Remove("Cookie");
            Client.DefaultRequestHeaders.Add("Cookie", cookie);
        }

        public async ValueTask DisposeAsync()
        {
            Client.Dispose();
            await App.StopAsync();
            await App.DisposeAsync();
            File.Delete(_path);
            File.Delete(_path + "-shm");
            File.Delete(_path + "-wal");
            var keys = TreasuryApplication.DefaultKeyDirectory(_path);
            if (Directory.Exists(keys)) Directory.Delete(keys, recursive: true);
        }
    }
}
