namespace Sendproof.Journeys;

/// <summary>The commands a step should send to a Redis store. Redis can't roll back, so the journey is Send only.</summary>
public sealed class RedisWrites
{
    private readonly StepWrites _writes;

    internal RedisWrites(StepWrites writes) => _writes = writes;

    /// <summary>The step sends this command to this key, such as <c>Command(RedisCommand.Incr, RedisKey.Format("coupon:{0}:uses", code))</c>.</summary>
    /// <param name="command">The write command.</param>
    /// <param name="key">The key, fixed or built from refs.</param>
    /// <param name="expiry">The expiry the command sets, such as <c>Match.Any&lt;TimeSpan&gt;()</c>.</param>
    public RedisWrites Command(RedisCommand command, RedisKey key, Matcher<TimeSpan>? expiry = null)
    {
        ArgumentNullException.ThrowIfNull(key);
        _writes.Check(key.Value, $"the Redis key {key}");
        _writes.Add(new RedisWrite(command, key.Value, expiry?.Value));
        return this;
    }
}
