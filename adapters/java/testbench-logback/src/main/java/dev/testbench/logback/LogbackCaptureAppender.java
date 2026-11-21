package dev.testbench.logback;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.classic.spi.IThrowableProxy;
import ch.qos.logback.core.AppenderBase;
import dev.testbench.core.CaptureContext;
import dev.testbench.core.RequestCapture;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * A Logback appender that copies the log events of the request running on this thread into its Test Bench capture. It
 * only records while a preview or observed send is active, and honors the application's log-level configuration.
 */
public final class LogbackCaptureAppender extends AppenderBase<ILoggingEvent> {

    @Override
    protected void append(ILoggingEvent event) {
        RequestCapture capture = CaptureContext.current();
        if (capture == null || !capture.isActive()) {
            return;
        }
        String logger = event.getLoggerName();
        // SQL is captured with parameters at the JDBC layer; skip the data layer's duplicate text logs.
        if (logger.equals("org.hibernate.SQL") || logger.startsWith("org.hibernate.orm.jdbc")
                || logger.startsWith("net.ttddyy.dsproxy")) {
            return;
        }
        Map<String, String> properties = null;
        if (event.getKeyValuePairs() != null && !event.getKeyValuePairs().isEmpty()) {
            properties = new LinkedHashMap<>();
            for (var pair : event.getKeyValuePairs()) {
                properties.put(pair.key, String.valueOf(pair.value));
            }
        }
        IThrowableProxy error = event.getThrowableProxy();
        capture.log(logger, level(event.getLevel()), event.getFormattedMessage(), properties,
                error == null ? null : error.getClassName(), error == null ? null : error.getMessage());
    }

    private static String level(Level level) {
        return switch (level.toInt()) {
            case Level.ERROR_INT -> "Error";
            case Level.WARN_INT -> "Warning";
            case Level.INFO_INT -> "Information";
            case Level.DEBUG_INT -> "Debug";
            default -> "Trace";
        };
    }
}
