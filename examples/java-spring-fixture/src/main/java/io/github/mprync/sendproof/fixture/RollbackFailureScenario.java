package io.github.mprync.sendproof.fixture;

import io.github.mprync.sendproof.core.PreviewObservation;
import io.github.mprync.sendproof.core.PreviewProvider;
import io.github.mprync.sendproof.core.PreviewSession;
import io.github.mprync.sendproof.jpa.JpaPreviewProvider;
import java.util.List;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Primary;
import org.springframework.context.annotation.Profile;

/**
 * The {@code rollback-failure} scenario: the usual provider captures and rolls back for real, then reports an injected
 * failure. Sendproof must withhold confirmation even though the database is unchanged.
 */
@Configuration
@Profile("scenario-rollback-failure")
public class RollbackFailureScenario {

    @Bean
    @Primary
    PreviewProvider failingRollbackProvider(JpaPreviewProvider delegate) {
        return new PreviewProvider() {
            @Override
            public boolean isAvailable() {
                return delegate.isAvailable();
            }

            @Override
            public String database() {
                return delegate.database();
            }

            @Override
            public PreviewSession begin() throws Exception {
                PreviewSession session = delegate.begin();
                return new PreviewSession() {
                    @Override
                    public List<io.github.mprync.sendproof.core.PreviewChange> changes() {
                        return session.changes();
                    }

                    @Override
                    public void rollback() throws Exception {
                        session.rollback();
                        throw new IllegalStateException("Injected rollback failure.");
                    }

                    @Override
                    public void close() throws Exception {
                        session.close();
                    }
                };
            }

            @Override
            public PreviewObservation beginObservation() throws Exception {
                return delegate.beginObservation();
            }
        };
    }
}
