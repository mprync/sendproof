package io.github.mprync.sendproof.spring;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;
import org.springframework.mock.env.MockEnvironment;

/** The preview filter must rewrite the request before Spring Security authorizes it. */
class FilterOrderTest {

    private static SendproofSettings order(int order) {
        var properties = new SendproofProperties();
        properties.setFilterOrder(order);
        return SendproofSettings.resolve(properties, null);
    }

    @Test
    void theDefaultRunsBeforeSpringSecurity() {
        var registration = new SendproofAutoConfiguration().sendproofFilter(order(-150), new MockEnvironment(), null);
        assertThat(registration.getOrder()).isEqualTo(-150);
    }

    @Test
    void anOrderAtOrAfterSpringSecurityIsRefusedAtStartup() {
        assertThatThrownBy(() -> new SendproofAutoConfiguration().sendproofFilter(order(-100), new MockEnvironment(), null))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("spring.security.filter.order");
        var moved = new MockEnvironment().withProperty("spring.security.filter.order", "-200");
        assertThatThrownBy(() -> new SendproofAutoConfiguration().sendproofFilter(order(-150), moved, null))
                .isInstanceOf(IllegalStateException.class);
    }
}
