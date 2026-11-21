package dev.testbench.spring;

import dev.testbench.core.TestBenchCapture;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.context.annotation.Bean;

/**
 * Always provides {@link TestBenchCapture}, even when Test Bench is disabled, so application code can inject it
 * unconditionally. Outside an active preview or observed send every {@code tryRecord*} call is a no-op that returns
 * {@code false}, meaning "deliver normally".
 */
@AutoConfiguration
public class TestBenchCaptureAutoConfiguration {

    @Bean
    @ConditionalOnMissingBean
    TestBenchCapture testBenchCapture() {
        return new TestBenchCapture();
    }
}
