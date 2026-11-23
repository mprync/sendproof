using Sendproof.Journeys;

namespace StoreApi;

/// <summary>
/// An order paid by bank transfer, from placing it to checking it shipped: place it, find its payment, capture the
/// transfer, ship the parcel and read the order back.
/// </summary>
public sealed class OrderToShipmentJourney : Journey<OrderToShipmentInputs>
{
    /// <inheritdoc />
    protected override void Define(JourneyBuilder<OrderToShipmentInputs> journey)
    {
        journey.Name("Order to shipment");
        journey.Group("Checkout and fulfilment");
        journey.RunAs("ada.admin@acme.dev");

        Ref<Guid> customerId = journey.Input(i => i.CustomerId);
        Ref<string> sku = journey.Input(i => i.Sku);
        Ref<int> quantity = journey.Input(i => i.Quantity);

        // 1. Place the order. A bank transfer leaves it Pending until the money arrives.
        var placeOrder = journey.Step("placeOrder", StoreOperations.Orders.Place);
        OrderRequests.Place(placeOrder, customerId, sku, quantity, journey.Input(i => i.ShippingSpeed), OrderRequests.BankTransfer);
        Ref<Guid> orderId = placeOrder.Output(order => order.Id, "orderId");
        placeOrder.ExpectWrites(writes => PlaceOrderWrites.Describe(writes, customerId, sku, quantity, journey.Input(i => i.CustomerEmail), orderId,
            PaymentMethodKind.BankTransfer));

        // 2. Find its payment.
        var findPayment = journey.Step("findPayment", StoreOperations.Payments.List);
        findPayment.Set(r => r.OrderId, orderId);
        findPayment.SucceedsWith(200);
        Ref<Guid> paymentId = findPayment.Output(page => page.Items[0].Id, "paymentId");
        findPayment.ExpectWrites(writes => writes.Nothing());

        // 3. Capture it: the transfer arrived, so the order is paid.
        var capturePayment = journey.Step("capturePayment", StoreOperations.Payments.Capture);
        capturePayment.Set(r => r.Id, paymentId);
        capturePayment.SucceedsWith(200);
        capturePayment.ExpectResponse(payment => payment.Status, PaymentStatus.Captured);
        capturePayment.ExpectWrites(writes => CapturePaymentWrites.Describe(writes, orderId, paymentId));

        // 4. Ship the parcel, and say what that should write.
        var shipOrder = journey.Step("shipOrder", StoreOperations.Shipments.Create);
        shipOrder.Set(r => r.Body.OrderId, orderId);
        shipOrder.Set(r => r.Body.Carrier, journey.Input(i => i.Carrier));
        shipOrder.SucceedsWith(201);
        shipOrder.ExpectWrites(writes => ShipOrderWrites.Describe(writes, journey, orderId));

        // 5. Read the order back.
        var checkOrder = journey.Step("checkOrder", StoreOperations.Orders.Get);
        checkOrder.Set(r => r.Id, orderId);
        checkOrder.SucceedsWith(200);
        checkOrder.ExpectResponse(order => order.Status, OrderStatus.Shipped);
        checkOrder.ExpectWrites(writes => writes.Nothing());
    }
}
