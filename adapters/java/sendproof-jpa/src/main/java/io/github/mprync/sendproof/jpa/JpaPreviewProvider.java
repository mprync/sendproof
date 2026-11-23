package io.github.mprync.sendproof.jpa;

import io.github.mprync.sendproof.core.HeldPreview;
import io.github.mprync.sendproof.core.PreviewObservation;
import io.github.mprync.sendproof.core.PreviewProvider;
import io.github.mprync.sendproof.core.PreviewSavepoint;
import io.github.mprync.sendproof.core.PreviewSession;
import io.github.mprync.sendproof.core.PreviewTurns;
import io.github.mprync.sendproof.core.TransactionControl;
import jakarta.persistence.EntityManagerFactory;
import java.sql.SQLException;
import java.util.List;
import java.util.Set;
import java.util.function.Supplier;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.support.JdbcTransactionManager;
import org.springframework.orm.jpa.EntityManagerFactoryInfo;
import org.springframework.orm.jpa.JpaTransactionManager;
import org.springframework.orm.jpa.vendor.HibernateJpaDialect;
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
    private final Supplier<String> system;
    private final CaptureDataSource heldDataSource;
    private final Supplier<String> heldSystem;
    private final PreviewTurns turns = new PreviewTurns();
    private volatile Set<String> safeProcedures = Set.of();

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
        this(transactions, entityManagerFactory, database, () -> null);
    }

    /**
     * Creates the provider.
     *
     * @param system supplies the SQL provider id ({@code postgresql}, {@code mysql}, {@code h2} ...) for capabilities
     *               {@code database.system}, or {@code null}
     */
    public JpaPreviewProvider(PlatformTransactionManager transactions, EntityManagerFactory entityManagerFactory,
                              Supplier<String> database, Supplier<String> system) {
        this.transactions = transactions;
        this.entityManagerFactory = entityManagerFactory != null ? entityManagerFactory
                : transactions instanceof JpaTransactionManager jpa ? jpa.getEntityManagerFactory() : null;
        this.database = database;
        this.system = system;
        this.heldDataSource = heldDataSource();
        this.heldSystem = DatabaseLabel.lazySystem(heldDataSource);
        if (transactions instanceof AbstractPlatformTransactionManager manager) {
            manager.addListener(new PreviewTransactionGuard());
        }
    }

    /**
     * Declares stored procedures that never commit, so a Preview on MySQL or MariaDB may {@code CALL} them. Every other
     * {@code CALL} is refused during a Preview, because a procedure can run {@code COMMIT} or an implicitly committing
     * statement inside the Preview transaction. Spring Boot sets this from {@code sendproof.sql.safe-procedures}.
     *
     * <p><b>Warning:</b> this is your statement that the procedures never commit. Sendproof trusts it: a listed procedure
     * that does commit persists the Preview's writes. Names match exactly ({@code audit_touch} or
     * {@code reports.refresh_totals}), case-insensitively, with no wildcards.
     *
     * @return this provider
     * @throws IllegalArgumentException for a blank name or one with a wildcard
     */
    public JpaPreviewProvider safeProcedures(String... names) {
        this.safeProcedures = TransactionControl.safeProcedures(List.of(names));
        return this;
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
    public String databaseSystem() {
        return system.get();
    }

    /**
     * On MySQL and MariaDB one Preview runs at a time per provider: see {@link PreviewTurns}. The turn is taken before
     * the transaction begins and handed on when the session closes.
     */
    @Override
    public PreviewSession begin() {
        String id = heldDatabaseSystem();
        if (!PreviewTurns.needed(id)) {
            return new JpaPreviewSession(transactions, entityManagerFactory, id, safeProcedures);
        }
        turns.acquire();
        try {
            return turns.holding(new JpaPreviewSession(transactions, entityManagerFactory, id, safeProcedures));
        } catch (RuntimeException | Error failure) {
            turns.release();
            throw failure;
        }
    }

    @Override
    public PreviewObservation beginObservation() {
        return new JpaObservation();
    }

    private CaptureDataSource heldDataSource() {
        if (transactions == null || !(JpaPreviewSession.transactionDataSource(transactions) instanceof CaptureDataSource source)
                || !source.canPin()) {
            return null;
        }
        Class<?> manager = transactions.getClass();
        if (manager == JpaTransactionManager.class) {
            var jpa = (JpaTransactionManager) transactions;
            return jpa.getJpaDialect() instanceof HibernateJpaDialect
                    && entityManagerFactory == jpa.getEntityManagerFactory()
                    && entityManagerFactory instanceof EntityManagerFactoryInfo info && info.getDataSource() == source
                    ? source : null;
        }
        return entityManagerFactory == null
                && (manager == DataSourceTransactionManager.class || manager == JdbcTransactionManager.class)
                ? source : null;
    }

    private String heldDatabaseSystem() {
        String configured = system.get();
        return configured != null ? configured : heldSystem.get();
    }

    @Override
    public boolean supportsHeldPreview() {
        return heldDataSource != null && PreviewSavepoint.supportsHeld(heldDatabaseSystem());
    }

    @Override
    public HeldPreview beginHeld() throws Exception {
        if (!supportsHeldPreview()) {
            throw new UnsupportedOperationException("The Spring transaction manager or DataSource cannot hold a Preview.");
        }
        String id = heldDatabaseSystem();
        boolean takesTurn = PreviewTurns.needed(id) || "sqlite".equals(id);
        if (takesTurn && !turns.tryAcquire()) {
            throw new HeldPreview.StoreBusy(id);
        }
        Runnable release = takesTurn ? turns::release : () -> { };
        try {
            return new JpaHeldPreview(transactions, entityManagerFactory, heldDataSource, id, safeProcedures, release);
        } catch (Exception | Error failure) {
            release.run();
            if (failure instanceof SQLException sql && PreviewSavepoint.isStoreBusy(id, sql)) {
                throw new HeldPreview.StoreBusy(id);
            }
            throw failure;
        }
    }
}
