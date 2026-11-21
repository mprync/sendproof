package io.github.mprync.sendproof.spring;

import io.github.mprync.sendproof.core.SendproofCapture;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.context.annotation.Bean;

/**
 * Always provides {@link SendproofCapture}, even when Sendproof is disabled, so application code can inject it
 * unconditionally. Outside an active preview or observed send every {@code tryRecord*} call is a no-op that returns
 * {@code false}, meaning "deliver normally".
 */
@AutoConfiguration
public class SendproofCaptureAutoConfiguration {

    @Bean
    @ConditionalOnMissingBean
    SendproofCapture sendproofCapture() {
        return new SendproofCapture();
    }
}
