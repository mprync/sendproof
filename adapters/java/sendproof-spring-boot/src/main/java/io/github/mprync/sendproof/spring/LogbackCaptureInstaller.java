package io.github.mprync.sendproof.spring;

import io.github.mprync.sendproof.logback.LogbackCapture;
import org.springframework.beans.factory.DisposableBean;
import org.springframework.beans.factory.InitializingBean;

/** Attaches the Logback capture appender for the life of the application context. */
final class LogbackCaptureInstaller implements InitializingBean, DisposableBean {
    private LogbackCapture installation;

    @Override
    public void afterPropertiesSet() {
        installation = LogbackCapture.install();
    }

    @Override
    public void destroy() {
        if (installation != null) {
            installation.close();
        }
    }
}
