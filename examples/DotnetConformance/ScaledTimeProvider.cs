using System.Diagnostics;

namespace DotnetConformance;

/// <summary>
/// A monotonic clock that runs <c>scale</c> times faster than real time. The adapter keeps observed traces for a
/// fixed five minutes and reads its clock from dependency injection, so a scale of 60 makes that five real seconds.
/// </summary>
internal sealed class ScaledTimeProvider(double scale) : TimeProvider
{
    private readonly long _origin = Stopwatch.GetTimestamp();

    public override long TimestampFrequency => Stopwatch.Frequency;

    public override long GetTimestamp() => (long)((Stopwatch.GetTimestamp() - _origin) * scale);

    public override ITimer CreateTimer(TimerCallback callback, object? state, TimeSpan dueTime, TimeSpan period) =>
        System.CreateTimer(callback, state, Compress(dueTime), Compress(period));

    private TimeSpan Compress(TimeSpan value) => value < TimeSpan.Zero ? value : value / scale;
}
