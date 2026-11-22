using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using StoreApi;
using Xunit;

/// <summary>
/// Integration tests of the Acme Store example on an in-memory test server with a new temporary SQLite database:
/// sign-in, Preview and Send, the order, shipment, refund and cancel flow, the seed data and the OpenAPI document.
/// </summary>
public sealed class StoreFlowTests
{
    private static readonly Guid Mia = Guid.Parse(DemoData.MiaId);
    private static readonly Guid Noah = Guid.Parse(DemoData.NoahId);

    /// <summary>The order the tests place: one black medium jacket for Mia, paid by card, delivered in Dublin.</summary>
    private static object OrderBody(int quantity = 1, Guid? customer = null, string token = "tok_visa_4242") => new
    {
        customerId = customer ?? Mia,
        items = new[] { new { sku = DemoData.JacketSku, quantity } },
        currency = "EUR",
        shippingAddress = new { recipient = "Mia Customer", line1 = "14 Harcourt Street", city = "Dublin", region = "Co. Dublin", postalCode = "D02 X285", country = "IE" },
        shippingSpeed = "Express",
        payment = new { type = "Card", token, brand = "Visa", holderName = "Mia Customer" }
    };

    [Fact]
    public async Task Authentication_preview_send_validation_and_switch_use_real_sqlite()
    {
        await using var host = await StoreHost.StartAsync();
        var (app, client) = (host.App, host.Client);
        Assert.Contains("app.js", await client.GetStringAsync("/sendproof/"));
        Assert.Contains("--accent", await client.GetStringAsync("/sendproof/styles.css"));
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync("/sendproof/package.json")).StatusCode);

        // The catalogue is public; orders are not.
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/api/v2/products")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/api/v2/categories")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/api/v2/orders")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await Preview(client, "/api/v2/orders", OrderBody())).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.PostAsJsonAsync("/auth/login", new { email = "mia.customer@acme.dev", password = "wrong" })).StatusCode);
        var login = await client.PostAsJsonAsync("/auth/login", new { email = "mia.customer@acme.dev", password = "Demo123!" });
        Assert.Equal(HttpStatusCode.OK, login.StatusCode);
        host.SetCookie(login);

        var baseline = await Counts(app);
        Assert.True(baseline.Orders >= 140, "The seed provides a realistic number of orders.");
        Assert.Equal((40, 0), await JacketStock(app));

        // Preview runs the real handler and rolls everything back: rows, stock, notifications.
        var preview = await Preview(client, "/api/v2/orders", OrderBody());
        var previewText = await preview.Content.ReadAsStringAsync();
        Assert.True(preview.IsSuccessStatusCode, previewText);
        using (var json = JsonDocument.Parse(previewText))
        {
            Assert.True(json.RootElement.GetProperty("rolledBack").GetBoolean());
            Assert.Equal(201, json.RootElement.GetProperty("status").GetInt32());
            var changes = json.RootElement.GetProperty("changes").EnumerateArray().Select(c => (c.GetProperty("operation").GetString(), c.GetProperty("table").GetString())).ToList();
            Assert.Contains(("insert", "Orders"), changes);
            Assert.Contains(("insert", "OrderLines"), changes);
            Assert.Contains(("insert", "Payments"), changes);
            Assert.Contains(("update", "Stock"), changes);
            // The side effects of one order: the confirmation email, the fulfilment webhook, the pick-list job and a message.
            var effects = json.RootElement.GetProperty("effects").EnumerateArray().ToList();
            Assert.Equal(new[] { "email", "http", "job", "message" }, effects.Select(e => e.GetProperty("kind").GetString()!).Order().ToArray());
            Assert.All(effects, effect => Assert.False(effect.TryGetProperty("delivered", out _)));
            Assert.Equal("mia.customer@acme.dev", effects.Single(e => e.GetProperty("kind").GetString() == "email").GetProperty("data").GetProperty("to")[0].GetString());
            Assert.Contains(json.RootElement.GetProperty("logs").EnumerateArray(), log => log.GetProperty("level").GetString() == "Sql");
            Assert.Contains("db;dur=", Assert.Single(preview.Headers.GetValues("Server-Timing")));
        }
        await AssertDatabase(app, baseline, 0, 40, 0);

        // Validation problems name each field, including those inside the lines.
        var invalid = await client.PostAsJsonAsync("/api/v2/orders", OrderBody(quantity: 0));
        Assert.Equal(HttpStatusCode.BadRequest, invalid.StatusCode);
        Assert.Contains("items[0].quantity", await invalid.Content.ReadAsStringAsync());
        Assert.Equal(HttpStatusCode.PaymentRequired, (await client.PostAsJsonAsync("/api/v2/orders", OrderBody(token: "tok_visa_0002"))).StatusCode);
        // A line asking for more than is available answers 409 and changes nothing.
        var scarce = await LowStockSku(app);
        var tooMany = new { customerId = Mia, items = new[] { new { sku = scarce, quantity = 20 } }, currency = "EUR", shippingAddress = new { recipient = "Mia", line1 = "1 Main St", city = "Dublin", postalCode = "D01", country = "IE" }, payment = new { type = "GiftCard", code = "GIFT-7K2M-9QXA-4D8P" } };
        Assert.Equal(HttpStatusCode.Conflict, (await client.PostAsJsonAsync("/api/v2/orders", tooMany)).StatusCode);
        await AssertDatabase(app, baseline, 0, 40, 0);

        using var send = Post("/api/v2/orders", OrderBody(), "test-order-1", trace: true);
        using var sent = await client.SendAsync(send);
        Assert.Equal(HttpStatusCode.Created, sent.StatusCode);
        Assert.Contains("db;dur=", Assert.Single(sent.Headers.GetValues("Server-Timing")));
        Assert.NotNull(sent.Headers.Location);
        var traceUrl = "/sendproof/_api/traces/" + Assert.Single(sent.Headers.GetValues("X-Sendproof-Trace"));
        var trace = await client.GetFromJsonAsync<JsonElement>(traceUrl);
        Assert.Contains(trace.GetProperty("changes").EnumerateArray(), change => change.GetProperty("operation").GetString() == "insert");
        Assert.All(trace.GetProperty("effects").EnumerateArray(), effect => Assert.True(effect.GetProperty("delivered").GetBoolean()));
        Assert.Equal(4, trace.GetProperty("effects").GetArrayLength());
        var sql = trace.GetProperty("logs").EnumerateArray().Count(log => log.GetProperty("level").GetString() == "Sql");
        Assert.True(sql > 0);
        Assert.Equal(sql, trace.GetProperty("timing").GetProperty("queryCount").GetInt32());
        await AssertDatabase(app, baseline, 1, 39, 4);

        // The same key and body replays the order; the same key with another body clashes.
        using var retry = Post("/api/v2/orders", OrderBody(), "test-order-1");
        Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(retry)).StatusCode);
        using var clash = Post("/api/v2/orders", OrderBody(quantity: 2), "test-order-1");
        Assert.Equal(HttpStatusCode.Conflict, (await client.SendAsync(clash)).StatusCode);
        await AssertDatabase(app, baseline, 1, 39, 4);

        // A customer cannot order for, or read, somebody else's records.
        Assert.Equal(HttpStatusCode.Forbidden, (await client.PostAsJsonAsync("/api/v2/orders", OrderBody(customer: Noah))).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync($"/api/v2/customers/{Noah}")).StatusCode);
        var mine = await client.GetFromJsonAsync<JsonElement>("/api/v2/orders?pageSize=100");
        Assert.All(mine.GetProperty("items").EnumerateArray(), order => Assert.Equal("mia.customer@acme.dev", order.GetProperty("customer").GetProperty("email").GetString()));

        // A warehouse persona may read stock but not order, preview or send.
        var warehouse = await client.PostAsync("/auth/personas/wes.warehouse%40acme.dev", null);
        host.SetCookie(warehouse);
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync(traceUrl)).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await Preview(client, "/api/v2/orders", OrderBody())).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.PostAsJsonAsync("/api/v2/orders", OrderBody())).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/api/v2/stock")).StatusCode);
        await AssertDatabase(app, baseline, 1, 39, 4);

        var spec = await client.GetStringAsync("/openapi/v1.json");
        Assert.Contains("x-lookup", spec);
        Assert.Contains("x-currency-field", spec);
        Assert.Contains("/api/v2/orders", spec);
    }

    [Fact]
    public async Task Order_flow_covers_cart_quote_shipment_refund_and_cancel_and_every_write_previews_without_persisting()
    {
        await using var host = await StoreHost.StartAsync();
        var (app, client) = (host.App, host.Client);
        await host.SignInAsync("mia.customer@acme.dev");
        var baseline = await Counts(app);

        // A cart holds stock; removing the line releases it.
        var cart = await (await client.PostAsJsonAsync($"/api/v2/customers/{Mia}/cart/items", new { sku = "SMF-SLO", quantity = 2 })).Content.ReadFromJsonAsync<JsonElement>();
        var itemId = cart.GetProperty("items")[0].GetProperty("id").GetString();
        Assert.Equal(2, await Reserved(app, "SMF-SLO"));
        Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync($"/api/v2/customers/{Noah}/cart")).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await client.DeleteAsync($"/api/v2/customers/{Mia}/cart/items/{itemId}")).StatusCode);
        Assert.Equal(0, await Reserved(app, "SMF-SLO"));

        // A quote prices a basket without creating anything, and a coupon check is read-only.
        var quote = await client.PostAsJsonAsync("/api/v2/quotes", new { items = new[] { new { sku = DemoData.JacketSku, quantity = 1 } }, currency = "EUR", shippingSpeed = "Express", couponCode = "ACME10", country = "IE" });
        Assert.Equal(HttpStatusCode.OK, quote.StatusCode);
        var priced = await quote.Content.ReadFromJsonAsync<JsonElement>();
        Assert.StartsWith("qt_", priced.GetProperty("id").GetString());
        Assert.True(priced.GetProperty("totals").GetProperty("discount").GetProperty("value").GetDecimal() > 0);
        var check = await client.GetFromJsonAsync<JsonElement>("/api/v2/coupons/ACME10/check?subtotal=100&currency=EUR");
        Assert.True(check.GetProperty("valid").GetBoolean());
        Assert.False((await client.GetFromJsonAsync<JsonElement>("/api/v2/coupons/SAVE20USD/check?subtotal=100&currency=EUR")).GetProperty("valid").GetBoolean());

        // Place two orders. A customer cannot ship or refund; the warehouse and support can.
        var first = await PlaceAsync(client, "flow-order-1");
        var second = await PlaceAsync(client, "flow-order-2");
        Assert.Equal((38, 0), await JacketStock(app));
        Assert.Equal(HttpStatusCode.Forbidden, (await client.PostAsJsonAsync("/api/v2/shipments", new { orderId = first, carrier = "Dhl" })).StatusCode);
        await host.SignInAsync("wes.warehouse@acme.dev");
        var shipmentBody = new { orderId = first, carrier = "Dhl" };
        var shipmentPreview = await PreviewJson(client, "/api/v2/shipments", shipmentBody);
        Assert.Contains(shipmentPreview.GetProperty("effects").EnumerateArray(), e => e.GetProperty("kind").GetString() == "email");
        Assert.Equal(0, (await client.GetFromJsonAsync<JsonElement>($"/api/v2/shipments?orderId={first}")).GetProperty("totalItems").GetInt32());
        var shipped = await client.PostAsJsonAsync("/api/v2/shipments", shipmentBody);
        Assert.Equal(HttpStatusCode.Created, shipped.StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, (await client.PostAsJsonAsync("/api/v2/shipments", shipmentBody)).StatusCode);
        var order = await client.GetFromJsonAsync<JsonElement>($"/api/v2/orders/{first}");
        Assert.Equal("Shipped", order.GetProperty("status").GetString());
        Assert.Equal(1, order.GetProperty("shipments").GetArrayLength());

        await host.SignInAsync("sam.support@acme.dev");
        var paymentId = order.GetProperty("payment").GetProperty("id").GetString();
        var total = order.GetProperty("totals").GetProperty("total").GetProperty("value").GetDecimal();
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await client.PostAsJsonAsync($"/api/v2/payments/{paymentId}/refunds", new { amount = total + 1, currency = "EUR", reason = "Damaged" })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.PostAsJsonAsync($"/api/v2/payments/{paymentId}/refunds", new { amount = 5, currency = "USD", reason = "Damaged" })).StatusCode);
        var refundBody = new { amount = 20m, currency = "EUR", reason = "Wrong item", note = "Sent the wrong colour." };
        await PreviewJson(client, $"/api/v2/payments/{paymentId}/refunds", refundBody);
        Assert.Equal(0m, (await client.GetFromJsonAsync<JsonElement>($"/api/v2/payments/{paymentId}")).GetProperty("refunded").GetProperty("value").GetDecimal());
        Assert.Equal(HttpStatusCode.Created, (await client.PostAsJsonAsync($"/api/v2/payments/{paymentId}/refunds", refundBody)).StatusCode);
        var payment = await client.GetFromJsonAsync<JsonElement>($"/api/v2/payments/{paymentId}");
        Assert.Equal("PartiallyRefunded", payment.GetProperty("status").GetString());
        Assert.Equal(20m, payment.GetProperty("refunded").GetProperty("value").GetDecimal());

        // A shipped order cannot be cancelled; an unshipped one can, with or without a reason, and its stock returns.
        Assert.Equal(HttpStatusCode.Conflict, (await client.PostAsync($"/api/v2/orders/{first}/cancel", null)).StatusCode);
        await PreviewJson<object>(client, $"/api/v2/orders/{second}/cancel", null);
        Assert.Equal("Paid", (await client.GetFromJsonAsync<JsonElement>($"/api/v2/orders/{second}")).GetProperty("status").GetString());
        var cancelled = await client.PostAsync($"/api/v2/orders/{second}/cancel", null);
        Assert.Equal(HttpStatusCode.OK, cancelled.StatusCode);
        Assert.Equal("Cancelled", (await cancelled.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("status").GetString());
        Assert.Equal((39, 0), await JacketStock(app));
        var secondPayment = await client.GetFromJsonAsync<JsonElement>($"/api/v2/payments?orderId={second}");
        Assert.Equal("Refunded", secondPayment.GetProperty("items")[0].GetProperty("status").GetString());

        // Every other write previews without persisting anything.
        await host.SignInAsync("ada.admin@acme.dev");
        var before = await Counts(app);
        var categoryId = (await client.GetFromJsonAsync<JsonElement>("/api/v2/categories")).EnumerateArray().First().GetProperty("id").GetGuid();
        var writes = new (string Path, object Body, HttpMethod Method)[]
        {
            ("/api/v2/categories", new { name = "Climbing", slug = "climbing" }, HttpMethod.Post),
            ("/api/v2/products", new
            {
                name = "Northpeak Trail Windbreaker", slug = "northpeak-trail-windbreaker", brand = "Northpeak", description = "A 110 g windbreaker.", categoryId,
                price = 89, currency = "USD", weightGrams = 110, variants = new[] { new { sku = "NPK-WND-ORG-M", color = "Orange", size = "M", initialStock = 25 } }
            }, HttpMethod.Post),
            ("/api/v2/coupons", new { kind = "Percentage", code = "WELCOME15", description = "Welcome offer.", percentOff = 15 }, HttpMethod.Post),
            ("/api/v2/coupons", new { kind = "FixedAmount", code = "SAVE5GBP", description = "Five pounds off.", amountOff = 5, currency = "GBP" }, HttpMethod.Post),
            ("/api/v2/coupons", new { kind = "FreeShipping", code = "SHIPFREE", description = "Free shipping." }, HttpMethod.Post),
            ($"/api/v2/stock/{DemoData.JacketSku}/adjustments", new { delta = 10, reason = "Received", reference = "PO-1" }, HttpMethod.Post),
            ("/api/v2/customers", new { email = "new.shopper@example.com", firstName = "New", lastName = "Shopper", preferredCurrency = "GBP" }, HttpMethod.Post),
            ($"/api/v2/customers/{Mia}/addresses", new { kind = "Shipping", label = "Office", address = new { recipient = "Mia Customer", line1 = "1 Grand Canal Dock", city = "Dublin", postalCode = "D02 K1X2", country = "IE" } }, HttpMethod.Post),
            ("/api/v2/users/2/role", new { role = "warehouse" }, HttpMethod.Put),
            ("/api/v2/coupons/ACME10/redemptions", new { count = 2 }, HttpMethod.Post),
        };
        foreach (var (path, body, method) in writes) await PreviewJson(client, path, body, method);
        Assert.Equal(before, await Counts(app));
        // Without Redis the redemption count lives in SQL: the preview left it alone and Send counts it.
        Assert.Equal(0, (await client.GetFromJsonAsync<JsonElement>("/api/v2/coupons?q=ACME10")).GetProperty("items")[0].GetProperty("redeemed").GetInt32());
        var redeemed = await client.PostAsJsonAsync("/api/v2/coupons/ACME10/redemptions", new { count = 2 });
        Assert.Equal(2, (await redeemed.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("redeemed").GetInt32());
        Assert.Equal(HttpStatusCode.BadRequest, (await client.PostAsJsonAsync("/api/v2/coupons/ACME10/redemptions", new { count = 0 })).StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, (await client.PostAsJsonAsync("/api/v2/coupons/BLACKFRI/redemptions", new { count = 1 })).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.PostAsJsonAsync("/api/v2/coupons/NOPE/redemptions", new { count = 1 })).StatusCode);

        // The product the preview would have created does not exist, and Send creates it for real with a union coupon.
        Assert.Equal(HttpStatusCode.Created, (await client.PostAsJsonAsync("/api/v2/coupons", new { kind = "FixedAmount", code = "SAVE5GBP", description = "Five pounds off.", amountOff = 5, currency = "GBP" })).StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, (await client.PostAsJsonAsync("/api/v2/coupons", new { kind = "FreeShipping", code = "SAVE5GBP", description = "Duplicate." })).StatusCode);
        var coupons = await client.GetFromJsonAsync<JsonElement>("/api/v2/coupons?pageSize=100");
        var created = coupons.GetProperty("items").EnumerateArray().Single(c => c.GetProperty("code").GetString() == "SAVE5GBP");
        Assert.Equal("FixedAmount", created.GetProperty("kind").GetString());
        Assert.Equal("GBP", created.GetProperty("currency").GetString());
        Assert.NotEqual(baseline, await Counts(app));
    }

    [Fact]
    public async Task Deprecated_operations_publish_replacements_and_sunset_and_enums_publish_descriptions()
    {
        await using var host = await StoreHost.StartAsync();
        await host.SignInAsync("wes.warehouse@acme.dev");
        using var document = JsonDocument.Parse(await host.Client.GetStringAsync("/openapi/v1.json"));
        var paths = document.RootElement.GetProperty("paths");
        var search = paths.GetProperty("/api/v1/products/search").GetProperty("get");
        Assert.True(search.GetProperty("deprecated").GetBoolean());
        var replacement = Assert.Single(search.GetProperty("x-replaced-by").EnumerateArray());
        Assert.Equal("ProductsController.List", replacement.GetProperty("operationId").GetString());
        Assert.Equal("$request.query.term", replacement.GetProperty("parameters").GetProperty("q").GetString());
        Assert.Equal("2027-03-31", search.GetProperty("x-sunset").GetString());
        var level = paths.GetProperty("/api/v2/products/{id}/stock").GetProperty("get");
        Assert.Equal(2, level.GetProperty("x-replaced-by").GetArrayLength());
        Assert.Equal("$request.path.id", level.GetProperty("x-replaced-by")[0].GetProperty("parameters").GetProperty("id").GetString());

        // The response says the same with headers.
        var hit = await host.Client.GetAsync("/api/v1/products/search?term=jacket");
        Assert.Equal(HttpStatusCode.OK, hit.StatusCode);
        Assert.Equal("true", Assert.Single(hit.Headers.GetValues("Deprecation")));
        Assert.Contains("Sunset", hit.Headers.Select(h => h.Key));
        Assert.Contains("successor-version", Assert.Single(hit.Headers.GetValues("Link")));
        Assert.Equal(HttpStatusCode.BadRequest, (await host.Client.GetAsync("/api/v1/products/search")).StatusCode);

        // Enum schemas carry a description per value, as do inline enums of request bodies.
        var schemas = document.RootElement.GetProperty("components").GetProperty("schemas");
        Assert.Equal("Cancelled before it shipped; stock released.", schemas.GetProperty("OrderStatus").GetProperty("x-enum-descriptions").GetProperty("Cancelled").GetString());
        var speed = schemas.GetProperty("PlaceOrderRequest").GetProperty("properties").GetProperty("shippingSpeed");
        Assert.Equal(new[] { "Standard", "Express", "Next day" }, speed.GetProperty("enum").EnumerateArray().Select(v => v.GetString()).ToArray());
        Assert.True(speed.GetProperty("x-sendproof-visible").GetBoolean());
        Assert.Equal("currency", schemas.GetProperty("RefundRequest").GetProperty("properties").GetProperty("amount").GetProperty("x-currency-field").GetString());
        Assert.Equal("SKU", schemas.GetProperty("OrderLineRequest").GetProperty("properties").GetProperty("sku").GetProperty("title").GetString());
        // Lookups: path parameters offer real records from a documented list operation.
        var lookup = paths.GetProperty("/api/v2/orders/{id}").GetProperty("get").GetProperty("parameters")[0].GetProperty("schema").GetProperty("x-lookup");
        Assert.Equal("/api/v2/orders?pageSize=50", lookup.GetProperty("url").GetString());
        Assert.Equal("number", lookup.GetProperty("labelField").GetString());
        // Public operations carry no security requirement; locked ones list the roles as scopes.
        Assert.False(paths.GetProperty("/api/v2/products").GetProperty("get").TryGetProperty("security", out _));
        var stock = paths.GetProperty("/api/v2/stock/{sku}/adjustments").GetProperty("post").GetProperty("security");
        Assert.Equal(new[] { "admin", "warehouse" }, stock.EnumerateArray().Select(s => s.GetProperty("cookieAuth")[0].GetString()!).Order().ToArray());
    }

    [Fact]
    public async Task Seed_data_is_realistic_consistent_and_reconciles()
    {
        await using var host = await StoreHost.StartAsync();
        using var scope = host.App.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<StoreDbContext>();

        Assert.True(await db.Products.CountAsync() >= 40);
        Assert.True(await db.Variants.CountAsync() >= 100);
        Assert.True(await db.Customers.CountAsync() >= 28);
        Assert.Equal(5, await db.Users.CountAsync(u => u.Role == "customer") - 1);
        Assert.Equal(new[] { "admin", "customer", "support", "warehouse" }, await db.Users.Select(u => u.Role).Distinct().OrderBy(r => r).ToArrayAsync());
        Assert.True(await db.Orders.CountAsync() >= 140);
        // Every status, currency, payment method and ship speed is present, so lists and filters have something to show.
        foreach (var status in Enum.GetValues<OrderStatus>()) Assert.True(await db.Orders.AnyAsync(o => o.Status == status), $"no {status} order");
        foreach (var status in Enum.GetValues<PaymentStatus>()) Assert.True(await db.Payments.AnyAsync(p => p.Status == status), $"no {status} payment");
        Assert.True(await db.Orders.Select(o => o.Currency).Distinct().CountAsync() >= 5);
        foreach (var kind in Enum.GetValues<PaymentMethodKind>()) Assert.True(await db.Payments.AnyAsync(p => p.Method == kind));
        Assert.True(await db.Coupons.CountAsync() >= 8);
        Assert.True(await db.Shipments.CountAsync() >= 60);
        Assert.True(await db.Reservations.AnyAsync(r => r.Status == ReservationStatus.Held));

        // Every variant is priced in every currency, and the jacket is a known quantity.
        var currencies = Enum.GetValues<Currency>().Length;
        Assert.Equal(await db.Variants.CountAsync() * currencies, await db.Prices.CountAsync());
        Assert.Equal(await db.Variants.CountAsync(), await db.Stock.CountAsync());
        Assert.Equal(10, (await db.Stock.SingleAsync(s => s.VariantId == db.Variants.Single(v => v.Sku == DemoData.JacketSku).Id)).ReorderPoint);

        // Orders add up, payments match orders, refunds match payments, and stock movements add up to the stock on hand.
        var lines = (await db.OrderLines.ToListAsync()).ToLookup(l => l.OrderId);
        var payments = (await db.Payments.ToListAsync()).ToLookup(p => p.OrderId);
        var refunds = (await db.Refunds.ToListAsync()).ToLookup(r => r.PaymentId);
        foreach (var order in await db.Orders.ToListAsync())
        {
            Assert.Equal(order.Subtotal, lines[order.Id].Sum(l => l.LineTotal));
            Assert.Equal(order.Subtotal - order.Discount + order.ShippingCost, order.Total);
            var payment = Assert.Single(payments[order.Id]);
            Assert.Equal(order.Total, payment.Amount);
            Assert.Equal(payment.RefundedAmount, refunds[payment.Id].Sum(r => r.Amount));
            Assert.True(payment.RefundedAmount <= payment.Amount);
        }
        var movements = (await db.StockMovements.ToListAsync()).GroupBy(m => m.VariantId).ToDictionary(g => g.Key, g => g.Sum(m => m.Delta));
        foreach (var stock in await db.Stock.ToListAsync()) Assert.Equal(stock.OnHand, movements[stock.VariantId]);
        // Held reservations are what the stock rows say is reserved.
        var held = (await db.Reservations.Where(r => r.Status == ReservationStatus.Held).ToListAsync()).GroupBy(r => r.VariantId).ToDictionary(g => g.Key, g => g.Sum(r => r.Quantity));
        foreach (var stock in await db.Stock.ToListAsync()) Assert.Equal(held.GetValueOrDefault(stock.VariantId), stock.Reserved);
        // Product ratings agree with the reviews that are seeded into MongoDB.
        foreach (var product in await db.Products.Where(p => p.Status == ProductStatus.Active).ToListAsync())
            Assert.Equal(ReviewSeed.Summary(product.Slug), (product.RatingAverage, product.ReviewCount));
        Assert.Equal(ReviewSeed.Create(await db.Products.ToListAsync()).Sum(d => d["count"].ToInt32()), await db.Products.SumAsync(p => p.ReviewCount));
    }

    [Fact]
    public async Task OpenApi_document_describes_every_operation_parameter_and_property()
    {
        await using var host = await StoreHost.StartAsync();
        using var document = JsonDocument.Parse(await host.Client.GetStringAsync("/openapi/v1.json"));
        var root = document.RootElement;
        var schemas = root.GetProperty("components").GetProperty("schemas");
        var problems = new List<string>();

        Assert.StartsWith("3.1", root.GetProperty("openapi").GetString());
        Assert.Equal("Acme Store API", root.GetProperty("info").GetProperty("title").GetString());
        Assert.True(root.GetProperty("info").GetProperty("description").GetString()!.Length > 1500, "A few paragraphs of narrative");
        Assert.True(root.GetProperty("info").TryGetProperty("contact", out _));
        Assert.True(root.GetProperty("info").TryGetProperty("license", out _));

        var tags = root.GetProperty("tags").EnumerateArray().ToList();
        Assert.True(tags.Count >= 10);
        foreach (var tag in tags)
            if (string.IsNullOrWhiteSpace(tag.TryGetProperty("description", out var text) ? text.GetString() : null))
                problems.Add($"tag {tag.GetProperty("name").GetString()} has no description");
        var tagNames = tags.Select(tag => tag.GetProperty("name").GetString()).ToHashSet();

        var operations = 0;
        var secured = 0;
        var deprecated = 0;
        var withExample = 0;
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
                if (body.TryGetProperty("requestBody", out var requestBody))
                {
                    if (IsBlank(requestBody, "description")) problems.Add($"{name} request body has no description");
                    var media = requestBody.GetProperty("content").EnumerateObject().First().Value;
                    var reference = media.GetProperty("schema").TryGetProperty("$ref", out var r) ? r.GetString()!.Split('/')[^1] : null;
                    if (reference is not null && schemas.TryGetProperty(reference, out var requestSchema) && !requestSchema.TryGetProperty("examples", out _) && !requestSchema.TryGetProperty("oneOf", out _))
                        problems.Add($"{name} request {reference} has no example");
                }
                foreach (var response in body.GetProperty("responses").EnumerateObject())
                {
                    if (IsBlank(response.Value, "description")) problems.Add($"{name} response {response.Name} has no description");
                    if (response.Value.TryGetProperty("content", out var content) && content.EnumerateObject().Any(m => m.Value.TryGetProperty("example", out _))) withExample++;
                }
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

        Assert.True(operations is >= 40 and <= 50, $"{operations} operations");
        Assert.True(secured >= 36, "Most operations need sign-in");
        Assert.True(deprecated >= 2, "Two operations are deprecated");
        Assert.True(withExample >= 40, "Error responses carry example bodies");
        // Two discriminated unions (payment methods and coupons), documented as oneOf with a mapping.
        var unions = schemas.EnumerateObject().Where(s => s.Value.TryGetProperty("discriminator", out _)).ToList();
        Assert.True(unions.Count >= 2, "Payment methods and coupons are discriminated unions");
        foreach (var union in unions)
        {
            Assert.True(union.Value.TryGetProperty("oneOf", out _), $"{union.Name} is a oneOf");
            Assert.True(union.Value.GetProperty("discriminator").TryGetProperty("mapping", out _), $"{union.Name} maps its variants");
        }
        Assert.Equal(new[] { "BankTransfer", "Card", "GiftCard" }, schemas.GetProperty("PaymentMethod").GetProperty("discriminator").GetProperty("mapping").EnumerateObject().Select(m => m.Name).Order().ToArray());
        // Constraints and formats the workbench relies on.
        var order = schemas.GetProperty("PlaceOrderRequest");
        Assert.Contains("customerId", order.GetProperty("required").EnumerateArray().Select(v => v.GetString()));
        Assert.Contains("payment", order.GetProperty("required").EnumerateArray().Select(v => v.GetString()));
        Assert.DoesNotContain("couponCode", order.GetProperty("required").EnumerateArray().Select(v => v.GetString()));
        Assert.Equal("uuid", order.GetProperty("properties").GetProperty("customerId").GetProperty("format").GetString());
        Assert.Equal(300, order.GetProperty("properties").GetProperty("note").GetProperty("maxLength").GetInt32());
        Assert.Equal(20, order.GetProperty("properties").GetProperty("items").GetProperty("maxItems").GetInt32());
        Assert.Equal("date", schemas.GetProperty("CouponPercentage").GetProperty("properties").GetProperty("expiresOn").GetProperty("format").GetString());
        Assert.Equal(0.01m, schemas.GetProperty("RefundRequest").GetProperty("properties").GetProperty("amount").GetProperty("multipleOf").GetDecimal());
        Assert.Contains("ProblemDetails", schemas.EnumerateObject().Select(s => s.Name));
        Assert.Contains("HttpValidationProblemDetails", schemas.EnumerateObject().Select(s => s.Name));
        var page = schemas.GetProperty("PagedListOfOrderSummary").GetProperty("required").EnumerateArray().Select(v => v.GetString()).ToList();
        Assert.Equal(new[] { "items", "page", "pageSize", "totalItems", "totalPages" }, page.ToArray());
        var list = root.GetProperty("paths").GetProperty("/api/v2/orders").GetProperty("get").GetProperty("parameters").EnumerateArray().ToList();
        var pageSize = list.Single(p => p.GetProperty("name").GetString() == "pageSize").GetProperty("schema");
        Assert.Equal((1, 100, 25), (pageSize.GetProperty("minimum").GetInt32(), pageSize.GetProperty("maximum").GetInt32(), pageSize.GetProperty("default").GetInt32()));
        Assert.Contains("-total", list.Single(p => p.GetProperty("name").GetString() == "sort").GetProperty("schema").GetProperty("enum").EnumerateArray().Select(v => v.GetString()));
        Assert.Empty(problems);
    }

    /// <summary>Password-less persona switching stays on this machine and same-origin unless the caller is already signed in.</summary>
    [Fact]
    public async Task Persona_switching_is_local_and_same_origin_for_anonymous_callers()
    {
        await using var host = await StoreHost.StartAsync();
        var server = host.App.GetTestServer();

        // An anonymous caller on another machine can neither list the seeded users nor become one.
        foreach (var (method, path) in new[] { ("GET", "/auth/personas"), ("POST", "/auth/personas/ada.admin%40acme.dev") })
        {
            var remote = await server.SendAsync(context =>
            {
                context.Request.Method = method;
                context.Request.Path = PathString.FromUriComponent(path);
                context.Connection.RemoteIpAddress = IPAddress.Parse("203.0.113.7");
            });
            Assert.Equal(StatusCodes.Status403Forbidden, remote.Response.StatusCode);
            Assert.False(remote.Response.Headers.ContainsKey("Set-Cookie"));
        }

        // A cross-site page cannot force a local browser into a seeded account.
        foreach (var (name, value) in new[] { ("Origin", "https://elsewhere.example.test"), ("Sec-Fetch-Site", "cross-site") })
        {
            using var crossSite = new HttpRequestMessage(HttpMethod.Post, "/auth/personas/ada.admin%40acme.dev");
            crossSite.Headers.Add(name, value);
            var response = await host.Client.SendAsync(crossSite);
            Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
            Assert.False(response.Headers.Contains("Set-Cookie"));
        }

        // The local, same-origin workbench flow keeps working, and a signed-in remote user may switch.
        await host.SignInAsync("ada.admin@acme.dev");
        var cookie = host.Client.DefaultRequestHeaders.GetValues("Cookie").Single();
        var signedIn = await server.SendAsync(context =>
        {
            context.Request.Method = "POST";
            context.Request.Path = PathString.FromUriComponent("/auth/personas/sam.support%40acme.dev");
            context.Request.Headers.Cookie = cookie;
            context.Connection.RemoteIpAddress = IPAddress.Parse("203.0.113.7");
        });
        Assert.Equal(StatusCodes.Status200OK, signedIn.Response.StatusCode);
    }

    [Fact]
    public void Cookie_keys_live_beside_the_demo_database()
    {
        var database = Path.Combine(Path.GetTempPath(), "store-demo.db");
        Assert.Equal(Path.Combine(Path.GetTempPath(), "store-demo.keys"), StoreApplication.DefaultKeyDirectory(database));
    }

    private static bool IsBlank(JsonElement element, string property) =>
        !element.TryGetProperty(property, out var value) || string.IsNullOrWhiteSpace(value.GetString());

    /// <summary>Places the standard order with an idempotency key as the signed-in customer, and returns its ID.</summary>
    private static async Task<Guid> PlaceAsync(HttpClient client, string key)
    {
        using var request = Post("/api/v2/orders", OrderBody(), key);
        using var response = await client.SendAsync(request);
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        return (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
    }

    private static HttpRequestMessage Post(string path, object body, string? idempotencyKey = null, bool trace = false)
    {
        var message = new HttpRequestMessage(HttpMethod.Post, path) { Content = JsonContent.Create(body) };
        if (idempotencyKey is not null) message.Headers.Add("Idempotency-Key", idempotencyKey);
        if (trace) message.Headers.Add("Prefer", "trace");
        return message;
    }

    private static Task<HttpResponseMessage> Preview<T>(HttpClient client, string path, T request) => PreviewResponse(client, path, request, HttpMethod.Post);

    private static async Task<HttpResponseMessage> PreviewResponse<T>(HttpClient client, string path, T? body, HttpMethod method)
    {
        using var message = new HttpRequestMessage(method, "/sendproof/_preview" + path);
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

    private sealed record Totals(int Orders, int Audit, int Products, int Categories, int Coupons, int Customers, int SupportUsers, int Shipments, int Refunds);

    private static async Task<Totals> Counts(WebApplication app)
    {
        using var scope = app.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<StoreDbContext>();
        return new Totals(await db.Orders.CountAsync(), await db.AuditEvents.CountAsync(), await db.Products.CountAsync(), await db.Categories.CountAsync(),
            await db.Coupons.CountAsync(), await db.Customers.CountAsync(), await db.Users.CountAsync(u => u.Role == "support"),
            await db.Shipments.CountAsync(), await db.Refunds.CountAsync());
    }

    /// <summary>The on-hand and reserved units of the black medium jacket.</summary>
    private static async Task<(int OnHand, int Reserved)> JacketStock(WebApplication app)
    {
        using var scope = app.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<StoreDbContext>();
        var stock = await db.Stock.SingleAsync(s => s.VariantId == db.Variants.Single(v => v.Sku == DemoData.JacketSku).Id);
        return (stock.OnHand, stock.Reserved);
    }

    /// <summary>The SKU of an on-sale variant with between 1 and 19 units available, so an order of 20 must be refused.</summary>
    private static async Task<string> LowStockSku(WebApplication app)
    {
        using var scope = app.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<StoreDbContext>();
        return await (from s in db.Stock join v in db.Variants on s.VariantId equals v.Id join p in db.Products on v.ProductId equals p.Id
                      where p.Status == ProductStatus.Active && s.OnHand - s.Reserved > 0 && s.OnHand - s.Reserved < 20 orderby v.Sku select v.Sku).FirstAsync();
    }

    private static async Task<int> Reserved(WebApplication app, string sku)
    {
        using var scope = app.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<StoreDbContext>();
        return (await db.Stock.SingleAsync(s => s.VariantId == db.Variants.Single(v => v.Sku == sku).Id)).Reserved;
    }

    /// <summary>Asserts the persisted state: <paramref name="added"/> orders (and audit events) beyond the seeded baseline, and the jacket's stock.</summary>
    private static async Task AssertDatabase(WebApplication app, Totals baseline, int added, int jacketOnHand, int notifications)
    {
        var now = await Counts(app);
        Assert.Equal(baseline.Orders + added, now.Orders);
        Assert.Equal(baseline.Audit + added, now.Audit);
        Assert.Equal(jacketOnHand, (await JacketStock(app)).OnHand);
        Assert.Equal(notifications, app.Services.GetRequiredService<DemoNotificationQueue>().Messages.Count);
    }

    /// <summary>A started Store application on an in-memory test server with a new temporary SQLite database.</summary>
    private sealed class StoreHost : IAsyncDisposable
    {
        private readonly string _path;
        private StoreHost(string path, WebApplication app) { _path = path; App = app; Client = app.GetTestClient(); }

        public WebApplication App { get; }
        public HttpClient Client { get; }

        public static async Task<StoreHost> StartAsync()
        {
            var path = Path.Combine(Path.GetTempPath(), $"store-test-{Guid.NewGuid():N}.db");
            var builder = WebApplication.CreateBuilder(new WebApplicationOptions
            {
                EnvironmentName = "Development", ApplicationName = typeof(StoreApplication).Assembly.FullName,
                Args = ["--hostBuilder:reloadConfigOnChange=false"]
            });
            builder.Services.AddDataProtection().UseEphemeralDataProtectionProvider();
            builder.Configuration["DemoDatabasePath"] = path;
            builder.WebHost.UseTestServer();
            var app = await StoreApplication.BuildAsync(builder);
            await app.StartAsync();
            return new StoreHost(path, app);
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
            // Pooled connections keep the database file open, and Windows will not delete an open file.
            Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
            File.Delete(_path);
            File.Delete(_path + "-shm");
            File.Delete(_path + "-wal");
            var keys = StoreApplication.DefaultKeyDirectory(_path);
            if (Directory.Exists(keys)) Directory.Delete(keys, recursive: true);
        }
    }
}
