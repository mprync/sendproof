package io.github.mprync.sendproof.logback;

import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.LoggerContext;
import org.slf4j.LoggerFactory;

/**
 * Attaches {@link LogbackCaptureAppender} to Logback's root logger so application logs appear in previews and traces.
 * It honors the logger levels you configured. Install once at startup and close it on shutdown.
 */
public final class LogbackCapture implements AutoCloseable {
    private final Logger root;
    private final LogbackCaptureAppender appender;

    private LogbackCapture(Logger root, LogbackCaptureAppender appender) {
        this.root = root;
        this.appender = appender;
    }

    /**
     * Installs the appender.
     *
     * @return the installation, or {@code null} when SLF4J is not backed by Logback
     */
    public static LogbackCapture install() {
        if (!(LoggerFactory.getILoggerFactory() instanceof LoggerContext context)) {
            return null;
        }
        Logger root = context.getLogger(org.slf4j.Logger.ROOT_LOGGER_NAME);
        var appender = new LogbackCaptureAppender();
        appender.setName("sendproof-capture");
        appender.setContext(context);
        appender.start();
        root.addAppender(appender);
        return new LogbackCapture(root, appender);
    }

    /** Detaches the appender. */
    @Override
    public void close() {
        root.detachAppender(appender);
        appender.stop();
    }
}
