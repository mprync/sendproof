using Microsoft.Extensions.Logging;

namespace Sendproof.AspNetCore;

[ProviderAlias("Sendproof")]
internal sealed class CaptureLoggerProvider(CaptureContext capture, SendproofOptions options) : ILoggerProvider
{
    internal const string CommandCategory = "Microsoft.EntityFrameworkCore.Database.Command";

    public ILogger CreateLogger(string categoryName) => new CaptureLogger(capture, options, categoryName);
    public void Dispose() { }

    private sealed class CaptureLogger(CaptureContext capture, SendproofOptions options, string category) : ILogger
    {
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => logLevel != LogLevel.None && capture.Current?.CanLog == true &&
            (!options.CaptureEfCommands || category != CommandCategory);

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception,
            Func<TState, Exception?, string> formatter)
        {
            if (IsEnabled(logLevel))
            {
                capture.Current?.Log(category, logLevel, eventId, state, exception, formatter);
            }
        }
    }
}
