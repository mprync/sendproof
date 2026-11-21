package io.github.mprync.sendproof.jpa;

import io.github.mprync.sendproof.core.PreviewObservation;
import io.github.mprync.sendproof.core.PreviewProvider;
import io.github.mprync.sendproof.core.PreviewSession;
import jakarta.persistence.EntityManagerFactory;
import java.util.function.Supplier;
import org.springframework.orm.jpa.JpaTransactionManager;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.AbstractPlatformTransactionManager;

/**
 * A preview provider for applications whose writes go through a Spring {@link PlatformTransactionManager}: JPA and
 * Hibernate (with before/after change capture), and {@code JdbcTemplate} or other JDBC code that uses Spring-managed
 * transactions (SQL capture only).
 *
 * <p>The preview opens an outer transaction before the handler; every {@code @Transactional} call joins it and the
 * whole unit is rolled back afterwards. Handlers that start a {@code REQUIRES_NEW} transaction, or run DML on a
 * connection outside any transaction, are refused rather than allowed to persist.
 */
public final class JpaPreviewProvider implements PreviewProvider {
    private final PlatformTransactionManager transactions;
    private final EntityManagerFactory entityManagerFactory;
    private final Supplier<String> database;

    /**
     * Creates the provider.
     *
     * @param transactions         the transaction manager the application's data access uses
     * @param entityManagerFactory the JPA factory for flush support, or {@code null} for JDBC-only applications;
     *                             taken from the transaction manager when it is a {@link JpaTransactionManager}
     * @param database             supplies the non-secret database label shown in the workbench
     */
    public JpaPreviewProvider(PlatformTransactionManager transactions, EntityManagerFactory entityManagerFactory,
                              Supplier<String> database) {
        this.transactions = transactions;
        this.entityManagerFactory = entityManagerFactory != null ? entityManagerFactory
                : transactions instanceof JpaTransactionManager jpa ? jpa.getEntityManagerFactory() : null;
        this.database = database;
        if (transactions instanceof AbstractPlatformTransactionManager manager) {
            manager.addListener(new PreviewTransactionGuard());
        }
    }

    @Override
    public boolean isAvailable() {
        return transactions != null;
    }

    @Override
    public String database() {
        return database.get();
    }

    @Override
    public PreviewSession begin() {
        return new JpaPreviewSession(transactions, entityManagerFactory);
    }

    @Override
    public PreviewObservation beginObservation() {
        return new JpaObservation();
    }
}
