using Sendproof.Journeys;

namespace StoreApi;

/// <summary>The order request the journeys place: delivered to Mia's Dublin address, in euro.</summary>
internal static class OrderRequests
{
    /// <summary>A bank transfer, which leaves the order <c>Pending</c> until the payment is captured.</summary>
    internal static readonly BankTransferPayment BankTransfer = new() { BankName = "Bank of Ireland", AccountHolder = "Mia Customer" };

    /// <summary>A test card the payment sandbox accepts, which pays the order at once.</summary>
    internal static readonly CardPayment Card = new() { Token = "tok_visa_4242", Brand = "Visa", HolderName = "Mia Customer" };

    /// <summary>Binds a place-order step: the customer, one line of the SKU, the speed and the payment.</summary>
    internal static void Place(JourneyStep<StoreOperations.Orders.PlaceRequest, Order> step, Ref<Guid> customerId, Ref<string> sku,
        Ref<int> quantity, Ref<string> shippingSpeed, PaymentMethod payment)
    {
        step.Set(r => r.Body.CustomerId, customerId);
        step.Set(r => r.Body.Items[0].Sku, sku);
        step.Set(r => r.Body.Items[0].Quantity, quantity);
        step.Set(r => r.Body.Currency, "EUR");
        step.Set(r => r.Body.ShippingAddress, new Address
        {
            Recipient = "Mia Customer", Line1 = "14 Harcourt Street", City = "Dublin", Region = "Co. Dublin", PostalCode = "D02 X285", Country = "IE"
        });
        step.Set(r => r.Body.ShippingSpeed, shippingSpeed);
        step.Set(r => r.Body.Payment, payment);
        step.SucceedsWith(201);
    }
}
