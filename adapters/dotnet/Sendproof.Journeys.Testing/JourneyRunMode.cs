namespace Sendproof.Journeys.Testing;

/// <summary>How a journey's steps are run.</summary>
public enum JourneyRunMode
{
    /// <summary>Every step previews inside one held Preview session, so nothing is written. Send-only journeys are sent.</summary>
    Preview,

    /// <summary>Every step is sent for real with Observed Send, so its writes can still be compared.</summary>
    Send
}
