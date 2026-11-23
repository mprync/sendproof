namespace Sendproof.Journeys;

/// <summary>
/// A value that exists only when the journey runs: one of its inputs, or an output of an earlier step. It is typed, so
/// a <c>Ref&lt;Guid&gt;</c> can only be set where a <see cref="Guid"/> goes. Get one from
/// <see cref="JourneyBuilder{TInputs}.Input{T}"/> or <see cref="JourneyStep{TRequest, TResponse}.Output{TValue}"/>.
/// </summary>
/// <typeparam name="T">The type of the value.</typeparam>
public sealed class Ref<T> : IRef
{
    internal Ref(JourneyRefSource source) => Source = source;

    internal JourneyRefSource Source { get; }

    JourneyRefSource IRef.Source => Source;

    /// <inheritdoc />
    public override string ToString() => Source.Describe();
}
