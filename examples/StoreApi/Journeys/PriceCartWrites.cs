using Sendproof.Journeys;

namespace StoreApi;

/// <summary>What pricing a basket writes: only the quote, cached in Redis until it expires.</summary>
public static class PriceCartWrites
{
    /// <summary>Describes the writes of the quote step.</summary>
    public static void Describe(StepWrites writes, Ref<string> quoteId)
    {
        writes.Redis("cache")
            .Command(RedisCommand.Set, RedisKey.Format("quote:{0}", quoteId), expiry: Match.Any<TimeSpan>());
    }
}
