using Sendproof.Journeys;

namespace StoreApi;

/// <summary>
/// An order paid by bank transfer that the warehouse tries to ship before the money arrives: the API refuses with 422
/// and writes nothing.
/// </summary>
public sealed class ShipUnpaidOrderJourney : Journey<OrderToShipmentInputs>
{
    /// <inheritdoc />
    protected override void Define(JourneyBuilder<OrderToShipmentInputs> journey)
    {
        journey.Name("Ship an unpaid order");
        journey.Group("Checkout and fulfilment");
        journey.RunAs("ada.admin@acme.dev");

        Ref<Guid> customerId = journey.Input(i => i.CustomerId);
        Ref<string> sku = journey.Input(i => i.Sku);
        Ref<int> quantity = journey.Input(i => i.Quantity);

        // 1. Place an order paid by bank transfer: it stays Pending.
        var placeOrder = journey.Step("placeOrder", StoreOperations.Orders.Place);
        OrderRequests.Place(placeOrder, customerId, sku, quantity, journey.Input(i => i.ShippingSpeed), OrderRequests.BankTransfer);
        Ref<Guid> orderId = placeOrder.Output(order => order.Id, "orderId");
        placeOrder.ExpectWrites(writes => PlaceOrderWrites.Describe(writes, customerId, sku, quantity, journey.Input(i => i.CustomerEmail),
            orderId, PaymentMethodKind.BankTransfer));

        // 2. Try to ship it: refused, and nothing is written.
        var shipOrder = journey.Step("shipOrder", StoreOperations.Shipments.Create);
        shipOrder.Set(r => r.Body.OrderId, orderId);
        shipOrder.Set(r => r.Body.Carrier, journey.Input(i => i.Carrier));
        shipOrder.SucceedsWith(422);
        shipOrder.ExpectWrites(writes => writes.Nothing());
    }
}
