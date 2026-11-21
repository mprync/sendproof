namespace TreasuryApi;

/// <summary>A tiny, deterministic stand-in for a bank's FX pricing: indicative mid rates, a spread and forward points.</summary>
internal static class FxMarket
{
    /// <summary>The spread the bank adds to the mid rate, in either direction (2 basis points).</summary>
    private const decimal Spread = 0.0002m;

    private static readonly Dictionary<FxPair, decimal> Mids = new()
    {
        [FxPair.EURUSD] = 1.08720m, [FxPair.EURGBP] = 0.85310m, [FxPair.GBPUSD] = 1.27440m, [FxPair.USDJPY] = 151.842m,
        [FxPair.EURJPY] = 165.090m, [FxPair.EURCHF] = 0.94210m, [FxPair.USDCHF] = 0.86650m, [FxPair.EURSEK] = 11.42100m,
        [FxPair.USDSEK] = 10.50430m
    };

    /// <summary>Annual money-market rates used to derive forward points.</summary>
    private static readonly Dictionary<Currency, decimal> Rates = new()
    {
        [Currency.EUR] = 0.0225m, [Currency.USD] = 0.0400m, [Currency.GBP] = 0.0375m, [Currency.JPY] = 0.0050m,
        [Currency.CHF] = 0.0025m, [Currency.SEK] = 0.0225m
    };

    /// <summary>The indicative mid rate of a pair.</summary>
    internal static decimal Mid(FxPair pair) => Mids[pair];

    /// <summary>How many decimal places rates of a pair are quoted with.</summary>
    internal static int RateDecimals(FxPair pair) => pair.ToString().EndsWith("JPY") ? 3 : 5;

    /// <summary>The spot value date: two business days after <paramref name="today"/>.</summary>
    internal static DateOnly SpotDate(DateOnly today) => AddBusinessDays(today, 2);

    /// <summary>Adds business days (Monday to Friday) to a date.</summary>
    internal static DateOnly AddBusinessDays(DateOnly date, int days)
    {
        while (days > 0)
        {
            date = date.AddDays(1);
            if (date.DayOfWeek is not (DayOfWeek.Saturday or DayOfWeek.Sunday)) days--;
        }
        return date;
    }

    /// <summary>Prices a deal. Forward points follow the interest-rate differential over the days beyond spot.</summary>
    internal static (decimal Rate, decimal ForwardPoints, DateOnly ValueDate) Price(FxPair pair, FxSide side, FxDealType type,
        DateOnly? requestedValueDate, DateOnly today)
    {
        var spot = SpotDate(today);
        var valueDate = type == FxDealType.Spot ? spot : requestedValueDate ?? spot;
        var (baseCurrency, quoteCurrency) = Mapping.Currencies(pair);
        var decimals = RateDecimals(pair);
        var mid = Mid(pair);
        var days = Math.Max(0, valueDate.DayNumber - spot.DayNumber);
        var points = type == FxDealType.Spot ? 0m : decimal.Round(mid * (Rates[quoteCurrency] - Rates[baseCurrency]) * days / 360m, decimals);
        var rate = decimal.Round((mid + points) * (side == FxSide.Buy ? 1 + Spread : 1 - Spread), decimals);
        return (rate, points, valueDate);
    }

    /// <summary>The quote-currency amount for a base amount at a rate, rounded to the currency's decimals.</summary>
    internal static decimal QuoteAmount(FxPair pair, decimal baseAmount, decimal rate) =>
        decimal.Round(baseAmount * rate, EndpointSupport.Decimals(Mapping.Currencies(pair).Quote));
}
