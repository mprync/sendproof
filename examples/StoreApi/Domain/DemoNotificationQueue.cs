using System.Collections.Concurrent;
using Sendproof.AspNetCore;

namespace StoreApi;

/// <summary>
/// A local, in-memory stand-in for the store's outbound side effects: customer email, the fulfilment webhook, warehouse
/// jobs and published messages. Nothing leaves the process.
/// </summary>
/// <remarks>
/// Every method records an effect with <see cref="SendproofPreview"/>. During a Preview the effect is captured and
/// suppressed; during a Send it is delivered, which here means it is appended to <see cref="Messages"/>.
/// </remarks>
public sealed class DemoNotificationQueue
{
    private const string Sender = "orders@acme-store.example";
    private const string SupportMailbox = "support@acme-store.example";
    private const string FulfilmentWebhook = "https://hooks.fulfilment.example/v1/orders";
    private readonly ConcurrentQueue<string> _messages = new();

    /// <summary>Gets the messages queued by committed requests in this process.</summary>
    public IReadOnlyCollection<string> Messages => _messages.ToArray();

    /// <summary>Confirms a new order to the customer, tells the fulfilment partner and queues the pick list.</summary>
    internal void OrderPlaced(OrderRecord order, string customerEmail, int itemCount, SendproofPreview preview)
    {
        Email(preview, $"Order confirmation {order.Number} to {customerEmail}", [customerEmail], $"Your Acme Store order {order.Number}",
            $"Thanks for your order. {itemCount} item(s), {order.Total:N2} {order.Currency}, shipping {order.ShippingSpeed}.");
        Http(preview, $"Notify fulfilment of {order.Number}", "POST", FulfilmentWebhook, 202,
            new { order.Id, order.Number, order.Currency, order.Total, itemCount, order.ShippingSpeed });
        Job(preview, $"Print the pick list for {order.Number}", "warehouse.pick-list", new { orderId = order.Id }, "warehouse");
        Message(preview, $"Publish {order.Number}", "store.orders.placed", new { order.Id, order.Number, order.Total, order.Currency });
        preview.TryRecordLog("Information", $"Order {order.Number} placed by {customerEmail}: {itemCount} item(s), {order.Total:N2} {order.Currency}.");
    }

    /// <summary>Tells the customer an order was cancelled and releases it with the fulfilment partner.</summary>
    internal void OrderCancelled(OrderRecord order, string customerEmail, SendproofPreview preview)
    {
        Email(preview, $"Order {order.Number} cancelled to {customerEmail}", [customerEmail], $"Your order {order.Number} was cancelled",
            $"The order was cancelled: {order.CancelReason ?? "no reason given"}. Any payment will be refunded.");
        Http(preview, $"Cancel {order.Number} with fulfilment", "DELETE", $"{FulfilmentWebhook}/{order.Id}", 204);
        preview.TryRecordLog("Warning", $"Order {order.Number} cancelled; stock released.");
    }

    /// <summary>Tells the customer their order shipped, with the tracking number.</summary>
    internal void ShipmentCreated(OrderRecord order, ShipmentRecord shipment, string customerEmail, SendproofPreview preview)
    {
        Email(preview, $"Shipping notice {order.Number} to {customerEmail}", [customerEmail], $"Your order {order.Number} is on its way",
            $"Shipped with {shipment.Carrier}. Track it with {shipment.TrackingNumber}. Expected {shipment.EstimatedDelivery:d MMM yyyy}.");
        Message(preview, $"Publish shipment {shipment.TrackingNumber}", "store.shipments.created", new { order.Id, shipment.TrackingNumber, shipment.Carrier });
        preview.TryRecordLog("Information", $"Order {order.Number} shipped with {shipment.Carrier} ({shipment.TrackingNumber}).");
    }

    /// <summary>Tells the customer about a refund and publishes it to the accounting system.</summary>
    internal void RefundIssued(OrderRecord order, RefundRecord refund, string customerEmail, SendproofPreview preview)
    {
        Email(preview, $"Refund for {order.Number} to {customerEmail}", [customerEmail], $"Your refund for order {order.Number}",
            $"We refunded {refund.Amount:N2} {refund.Currency}. It reaches your payment method in 3 to 5 working days.");
        Message(preview, $"Publish refund {refund.Id}", "store.payments.refunded", new { refund.Id, order = order.Number, refund.Amount, refund.Currency });
        preview.TryRecordLog("Warning", $"Refunded {refund.Amount:N2} {refund.Currency} on order {order.Number} ({refund.Reason}).");
    }

    /// <summary>Welcomes a new customer.</summary>
    internal void CustomerRegistered(CustomerRecord customer, SendproofPreview preview)
    {
        Email(preview, $"Welcome email to {customer.Email}", [customer.Email], "Welcome to Acme Store",
            $"Hi {customer.FirstName}, your account is ready. Use ACME10 for 10% off your first order.");
        preview.TryRecordLog("Information", $"Customer {customer.Email} registered.");
    }

    /// <summary>Publishes a new product so the search index can pick it up.</summary>
    internal void ProductCreated(ProductRecord product, SendproofPreview preview)
    {
        Message(preview, $"Publish product {product.Slug}", "store.catalog.product-created", new { product.Id, product.Slug, product.Name });
        Job(preview, $"Reindex {product.Slug} in search", "search.reindex", new { productId = product.Id }, "search");
        preview.TryRecordLog("Information", $"Product {product.Name} created.");
    }

    /// <summary>Asks the warehouse to reorder a variant whose stock fell to its reorder point.</summary>
    internal void StockLow(string sku, int available, SendproofPreview preview)
    {
        Job(preview, $"Reorder {sku} from the supplier", "purchasing.reorder", new { sku, available }, "purchasing");
        preview.TryRecordLog("Warning", $"Stock of {sku} is low: {available} available.");
    }

    /// <summary>Tells the support mailbox that a customer wrote a review that may need an answer.</summary>
    internal void ReviewAdded(ProductRecord product, int rating, SendproofPreview preview)
    {
        if (rating <= 2)
            Email(preview, $"Low review of {product.Name}", [SupportMailbox], $"{rating}-star review of {product.Name}",
                "A customer left a low rating. Consider replying.");
        preview.TryRecordLog("Information", $"A {rating}-star review was added to {product.Name}.");
    }

    /// <summary>Tells a user their role changed and publishes the change for access reviews.</summary>
    internal void RoleChanged(DemoUser user, string previousRole, SendproofPreview preview)
    {
        Email(preview, $"Role of {user.Email} changed", [user.Email], "Your Acme Store role changed",
            $"Your role changed from {previousRole} to {user.Role}. Sign in again to use it.");
        Message(preview, $"Publish role change for {user.Email}", "store.access.role-changed", new { user.Email, previousRole, user.Role });
        preview.TryRecordLog("Warning", $"Role of {user.Email} changed from {previousRole} to {user.Role}.");
    }

    /// <summary>Tells the support mailbox about a new coupon.</summary>
    internal void CouponCreated(CouponRecord coupon, SendproofPreview preview)
    {
        Email(preview, $"Coupon {coupon.Code} created", [SupportMailbox], $"New coupon: {coupon.Code}", coupon.Description);
        preview.TryRecordLog("Information", $"Coupon {coupon.Code} created.");
    }

    private void Email(SendproofPreview preview, string description, string[] to, string subject, string text)
    {
        if (!preview.TryRecordEmail(description, Sender, to, [], subject, text)) _messages.Enqueue(description);
    }

    private void Http(SendproofPreview preview, string description, string method, string url, int status, object? body = null)
    {
        if (!preview.TryRecordHttp(description, method, url, status, body)) _messages.Enqueue(description);
    }

    private void Job(SendproofPreview preview, string description, string name, object arguments, string queue)
    {
        if (!preview.TryRecordJob(description, name, arguments, queue)) _messages.Enqueue(description);
    }

    private void Message(SendproofPreview preview, string description, string topic, object payload)
    {
        if (!preview.TryRecordMessage(description, topic, payload)) _messages.Enqueue(description);
    }
}
