namespace Sendproof.Journeys;

/// <summary>
/// What a step should write and which effects it should hold or send. Each store adds its own entry point as an
/// extension (<c>Sql&lt;TDbContext&gt;()</c> in <c>Sendproof.Journeys.EntityFrameworkCore</c>, <c>Mongo()</c> in
/// <c>Sendproof.Journeys.MongoDB</c>), so a new store plugs in the same way. A change to a table or collection that
/// isn't listed fails the step.
/// </summary>
public sealed class StepWrites
{
    private bool _nothing;

    internal StepWrites(JourneyModel journey, StepModel step)
    {
        Journey = journey;
        Step = step;
    }

    internal JourneyModel Journey { get; }
    internal StepModel Step { get; }
    internal List<ExpectedWrite> Writes { get; } = [];
    internal List<ExpectedEffect> Effects { get; } = [];

    /// <summary>Gets whether <see cref="Nothing"/> was called, so the step must hold or send no effects either.</summary>
    internal bool ExpectsNothing => _nothing;

    /// <summary>The step must write nothing and hold no effects, such as a read or an expected refusal.</summary>
    public void Nothing() => _nothing = true;

    /// <summary>The step holds (Preview) or sends (Send) one email.</summary>
    public EmailExpectation Email()
    {
        var effect = new ExpectedEffect("email");
        Add(effect);
        return new EmailExpectation(this, effect);
    }

    /// <summary>The step writes to the Redis store with this name. Redis can't roll back, so the journey is Send only.</summary>
    /// <param name="name">The store's name, as registered with <c>AddRedis(redis =&gt; redis.WithName("cache"))</c>.</param>
    public RedisWrites Redis(string name)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(name);
        return new RedisWrites(this);
    }

    internal void Add(ExpectedWrite write)
    {
        CheckNotNothing();
        Writes.Add(write);
    }

    internal void Add(ExpectedEffect effect)
    {
        CheckNotNothing();
        Effects.Add(effect);
    }

    /// <summary>Records a problem for each ref the value can't read yet; writes are compared after the response.</summary>
    internal void Check(JourneyValue value, string where) => Journey.Check(value, Step, afterResponse: true, where);

    private void CheckNotNothing()
    {
        if (_nothing)
        {
            Journey.Problems.Add($"Step {Step.StepId}: it expects nothing, so it can't also expect a write or an effect.");
        }
    }
}
