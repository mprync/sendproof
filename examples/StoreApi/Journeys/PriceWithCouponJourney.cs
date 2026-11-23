using Sendproof.Journeys;
using Sendproof.Journeys.EntityFrameworkCore;

namespace StoreApi;

/// <summary>
/// Checks a coupon, prices a basket with it and redeems it. Quoting caches the quote in Redis and redeeming counts the
/// coupon there, and Redis can't roll back, so this journey is Send only.
/// </summary>
public sealed class PriceWithCouponJourney : Journey<PriceWithCouponInputs>
{
    /// <inheritdoc />
    protected override void Define(JourneyBuilder<PriceWithCouponInputs> journey)
    {
        journey.Name("Price with a coupon");
        journey.Group("Carts");
        journey.RunAs("ada.admin@acme.dev");

        Ref<string> couponCode = journey.Input(i => i.CouponCode);

        // 1. Check the coupon applies to a basket of this size.
        var checkCoupon = journey.Step("checkCoupon", StoreOperations.Coupons.Check);
        checkCoupon.Set(r => r.Code, couponCode);
        checkCoupon.Set(r => r.Subtotal, 347.98m);
        checkCoupon.Set(r => r.Currency, Currency.EUR);
        checkCoupon.SucceedsWith(200);
        checkCoupon.ExpectResponse(check => check.Valid, true);
        checkCoupon.ExpectWrites(writes => writes.Nothing());

        // 2. Price the basket with the coupon: the quote is cached in Redis for 15 minutes.
        var priceCart = journey.Step("priceCart", StoreOperations.Carts.Quote);
        priceCart.Set(r => r.Body.Items[0].Sku, journey.Input(i => i.Sku));
        priceCart.Set(r => r.Body.Items[0].Quantity, journey.Input(i => i.Quantity));
        priceCart.Set(r => r.Body.Currency, "EUR");
        priceCart.Set(r => r.Body.ShippingSpeed, "Standard");
        priceCart.Set(r => r.Body.CouponCode, couponCode);
        priceCart.Set(r => r.Body.Country, "IE");
        priceCart.SucceedsWith(200);
        Ref<string> quoteId = priceCart.Output(quote => quote.Id, "quoteId");
        priceCart.ExpectWrites(writes => PriceCartWrites.Describe(writes, quoteId));

        // 3. Redeem the coupon once: SQL keeps a copy of the Redis counter.
        var redeemCoupon = journey.Step("redeemCoupon", StoreOperations.Coupons.Redeem);
        redeemCoupon.Set(r => r.Code, couponCode);
        redeemCoupon.Set(r => r.Body.Count, 1);
        redeemCoupon.SucceedsWith(200);
        redeemCoupon.ExpectWrites(writes =>
        {
            var sql = writes.Sql<StoreDbContext>();
            sql.Update(db => db.Coupons)
                .Set(c => c.Code, couponCode)
                .Set(c => c.Redeemed, Match.Any<int>());
            sql.Insert(db => db.AuditEvents)
                .Set(a => a.EntityType, "Coupon")
                .Set(a => a.Action, "Coupon.Redeemed: +1");
            writes.Redis("cache")
                .Command(RedisCommand.IncrBy, RedisKey.Format("coupon:redemptions:{0}", couponCode));
        });
    }
}
