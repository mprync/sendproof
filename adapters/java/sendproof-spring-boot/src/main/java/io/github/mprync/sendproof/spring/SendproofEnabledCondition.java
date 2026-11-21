package io.github.mprync.sendproof.spring;

import java.util.List;
import java.util.Locale;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionOutcome;
import org.springframework.boot.autoconfigure.condition.SpringBootCondition;
import org.springframework.boot.context.properties.bind.Bindable;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.context.annotation.ConditionContext;
import org.springframework.core.env.Environment;
import org.springframework.core.type.AnnotatedTypeMetadata;

/**
 * Sendproof exists only when {@code sendproof.enabled=true}, and never under a production profile unless
 * {@code sendproof.allow-in-production=true}. A refusal is logged so it is not mistaken for a misconfiguration.
 */
public final class SendproofEnabledCondition extends SpringBootCondition {
    private static final Logger LOG = LoggerFactory.getLogger(SendproofEnabledCondition.class);

    @Override
    public ConditionOutcome getMatchOutcome(ConditionContext context, AnnotatedTypeMetadata metadata) {
        Environment environment = context.getEnvironment();
        if (!environment.getProperty("sendproof.enabled", Boolean.class, false)) {
            return ConditionOutcome.noMatch("sendproof.enabled is not true");
        }
        List<String> blocked = Binder.get(environment).bind("sendproof.blocked-profiles", Bindable.listOf(String.class))
                .orElse(List.of("prod", "production"));
        boolean allowed = environment.getProperty("sendproof.allow-in-production", Boolean.class, false);
        for (String profile : environment.getActiveProfiles()) {
            if (!allowed && blocked.stream().anyMatch(name -> name.toLowerCase(Locale.ROOT)
                    .equals(profile.toLowerCase(Locale.ROOT)))) {
                LOG.warn("Sendproof is enabled but the '{}' profile is blocked; it stays off. "
                        + "Set sendproof.allow-in-production=true to override.", profile);
                return ConditionOutcome.noMatch("profile '" + profile + "' is blocked");
            }
        }
        return ConditionOutcome.match("sendproof.enabled is true");
    }
}
