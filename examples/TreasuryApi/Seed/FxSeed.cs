namespace TreasuryApi;

/// <summary>Seeds about 30 spot and forward FX deals with realistic rates, banks and statuses.</summary>
internal static class FxSeed
{
    private static readonly string[] Banks = ["J.P. Morgan", "Deutsche Bank", "BNP Paribas", "HSBC", "Barclays", "Commerzbank", "ING"];

    private static readonly string[] CancelReasons =
        ["Exposure no longer required.", "Booked in error: wrong currency pair.", "Customer receipt delayed.", "Hedge restructured with another bank."];

    private static readonly FxPair[] Pairs =
        [FxPair.EURUSD, FxPair.EURUSD, FxPair.EURUSD, FxPair.EURGBP, FxPair.EURGBP, FxPair.GBPUSD, FxPair.USDJPY, FxPair.EURJPY,
         FxPair.EURCHF, FxPair.USDCHF, FxPair.EURSEK, FxPair.USDSEK];

    /// <summary>Builds the deals: finished ones in the past and booked ones that settle in the coming weeks.</summary>
    internal static List<FxDealRecord> Create(Random rng, DateTimeOffset now, DateOnly today, IReadOnlyList<DemoUser> users)
    {
        var dealers = users.Where(u => u.IsActive && u.Role is "payments.approve" or "admin").ToList();
        var deals = new List<FxDealRecord>();
        // (count, status, forward?) groups: settled and cancelled in the past, booked in the future.
        var plan = new (int Count, FxDealStatus Status, bool Future)[]
        {
            (13, FxDealStatus.Settled, false), (11, FxDealStatus.Booked, true), (5, FxDealStatus.Cancelled, true), (2, FxDealStatus.Cancelled, false)
        };
        foreach (var (count, status, future) in plan)
            for (var i = 0; i < count; i++)
            {
                var pair = rng.Pick(Pairs);
                var type = future ? (rng.Chance(0.6) ? FxDealType.Forward : FxDealType.Spot) : (rng.Chance(0.25) ? FxDealType.Forward : FxDealType.Spot);
                DateOnly trade, value;
                if (type == FxDealType.Spot)
                {
                    // A settled spot deal was struck weeks ago; a booked one was struck today or yesterday.
                    trade = SeedRandom.PreviousBusinessDay(future ? today.AddDays(-rng.Between(0, 1)) : today.AddDays(-rng.Between(4, 70)));
                    value = FxMarket.SpotDate(trade);
                    if (future && value < today) value = FxMarket.SpotDate(today);
                }
                else
                {
                    trade = SeedRandom.PreviousBusinessDay(today.AddDays(-rng.Between(2, 55)));
                    var tenor = rng.Pick(new[] { 30, 60, 90, 120, 180 });
                    value = SeedRandom.BusinessDay(trade.AddDays(tenor));
                    // Settled forwards matured already; booked forwards must still be open.
                    while (!future && value >= today) value = value.AddDays(-14);
                    while (future && value <= today) value = value.AddDays(21);
                    value = SeedRandom.BusinessDay(value);
                }
                var side = rng.Chance(0.55) ? FxSide.Buy : FxSide.Sell;
                var baseAmount = rng.Pick(new[] { 100_000m, 150_000m, 250_000m, 400_000m, 500_000m, 750_000m, 1_000_000m, 2_000_000m, 3_500_000m, 5_000_000m });
                if (pair is FxPair.USDJPY or FxPair.EURSEK or FxPair.USDSEK) baseAmount = Math.Round(baseAmount / 10_000m) * 10_000m;
                // Dealt rates drift around the mid-rate, as markets do over a couple of months.
                var drift = 1m + (decimal)((rng.NextDouble() - 0.5) * 0.05);
                var decimals = FxMarket.RateDecimals(pair);
                var spot = decimal.Round(FxMarket.Mid(pair) * drift * (side == FxSide.Buy ? 1.0002m : 0.9998m), decimals);
                var points = 0m;
                if (type == FxDealType.Forward)
                {
                    var (b, q) = Mapping.Currencies(pair);
                    var days = value.DayNumber - FxMarket.SpotDate(trade).DayNumber;
                    var diff = (Rate(q) - Rate(b)) * days / 360m;
                    points = decimal.Round(spot * diff, decimals);
                }
                var rate = spot + points;
                var booker = rng.Pick(dealers);
                var bookedAt = new DateTimeOffset(trade.ToDateTime(new TimeOnly(rng.Between(8, 16), rng.Between(0, 59)), DateTimeKind.Utc));
                if (bookedAt > now) bookedAt = now.AddMinutes(-rng.Between(20, 300));
                deals.Add(new FxDealRecord
                {
                    Id = rng.NextGuid(), Number = "", Type = type, Pair = pair, Side = side, BaseAmount = baseAmount,
                    QuoteAmount = FxMarket.QuoteAmount(pair, baseAmount, rate), Rate = rate, ForwardPoints = points, TradeDate = trade,
                    ValueDate = value, Status = status, Bank = rng.Pick(Banks), BookedBy = booker.Email, BookedAt = bookedAt,
                    CancelReason = status == FxDealStatus.Cancelled ? rng.Pick(CancelReasons) : null
                });
            }
        foreach (var group in deals.OrderBy(d => d.BookedAt).GroupBy(d => d.BookedAt.Year))
        {
            var sequence = 1;
            foreach (var deal in group) deal.Number = $"FX-{group.Key}-{sequence++:0000}";
        }
        return deals;
    }

    private static decimal Rate(Currency currency) => currency switch
    {
        Currency.EUR or Currency.SEK => 0.0225m, Currency.USD => 0.04m, Currency.GBP => 0.0375m, Currency.JPY => 0.005m, _ => 0.0025m
    };
}
