package io.github.mprync.sendproof.jpa;

import io.github.mprync.sendproof.core.DatabaseSystem;
import io.github.mprync.sendproof.core.PreviewChange;
import io.github.mprync.sendproof.core.PreviewSavepoint;
import io.github.mprync.sendproof.core.PreviewSession;
import io.github.mprync.sendproof.core.TransactionControl;
import jakarta.persistence.EntityManager;
import jakarta.persistence.EntityManagerFactory;
import java.sql.Connection;
import java.sql.SQLException;
import java.util.List;
import java.util.Set;
import javax.sql.DataSource;
import net.ttddyy.dsproxy.proxy.ProxyJdbcObject;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DataSourceUtils;
import org.springframework.orm.jpa.EntityManagerFactoryUtils;
import org.springframework.orm.jpa.JpaTransactionManager;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionStatus;
import org.springframework.transaction.support.DefaultTransactionDefinition;
import org.springframework.transaction.support.TransactionSynchronizationManager;

/**
 * One preview's outer Spring transaction. Handler code that uses {@code @Transactional}, Spring Data repositories,
 * {@code JdbcTemplate} or an injected {@code EntityManager} joins it, so every write is part of one transaction that
 * is always rolled back. Pending entity changes are flushed before the rollback so their SQL runs, their
 * constraints are checked and their changes are captured.
 *
 * <p>On MySQL and MariaDB the session keeps a {@link PreviewSavepoint} as a backstop: if it is gone when the Preview
 * ends, something committed the transaction, and {@link #rollback()} fails so the Preview answers 500.
 */
final class JpaPreviewSession implements PreviewSession {
    private final PlatformTransactionManager transactions;
    private final EntityManagerFactory entityManagerFactory;
    private final TransactionStatus status;
    private final ChangeLog changes;
    private final PreviewTransactionGuard.Scope guard;
    private final PreviewSavepoint savepoint;

    /**
     * Opens the Preview's outer transaction.
     *
     * @param system         the SQL provider id, or {@code null} to read it from the transaction's connection
     * @param safeProcedures procedures the host declared never commit, normalised by {@link TransactionControl}
     */
    JpaPreviewSession(PlatformTransactionManager transactions, EntityManagerFactory entityManagerFactory, String system,
                      Set<String> safeProcedures) {
        this.transactions = transactions;
        this.entityManagerFactory = entityManagerFactory;
        this.changes = ChangeLog.open();
        this.guard = PreviewTransactionGuard.enter(this::flush, system, safeProcedures);
        TransactionStatus started = null;
        PreviewSavepoint made = null;
        try {
            started = transactions.getTransaction(new DefaultTransactionDefinition());
            made = openSavepoint(system);
            guard.savepoint(made);
            guard.started();
        } catch (RuntimeException | Error failure) {
            // Nothing was acquired, or the begin failed part-way: release everything this constructor took.
            try {
                if (started != null && !started.isCompleted()) {
                    transactions.rollback(started);
                }
            } finally {
                guard.close();
                changes.close();
            }
            throw failure;
        }
        this.status = started;
        this.savepoint = made;
    }

    /**
     * Makes the backstop {@link PreviewSavepoint} in the transaction just opened, on every SQL database, on the pool's
     * connection so the probe stays out of the SQL log. Needs the transaction manager's {@link DataSource} (JPA and
     * JDBC transaction managers); without one there is no backstop and this returns {@code null}. Also settles the
     * guard's database when the provider didn't name one.
     */
    private PreviewSavepoint openSavepoint(String system) {
        DataSource dataSource = transactions instanceof JpaTransactionManager jpa ? jpa.getDataSource()
                : transactions instanceof DataSourceTransactionManager jdbc ? jdbc.getDataSource() : null;
        if (dataSource == null || !TransactionSynchronizationManager.hasResource(dataSource)) {
            return null;
        }
        Connection connection = DataSourceUtils.getConnection(dataSource);
        try {
            String id = system != null ? system : DatabaseSystem.of(connection.getMetaData().getDatabaseProductName());
            guard.system(id);
            Connection physical = connection instanceof ProxyJdbcObject proxy && proxy.getTarget() instanceof Connection target
                    ? target : connection;
            return PreviewSavepoint.open(physical, id);
        } catch (SQLException failure) {
            throw new IllegalStateException("The Preview's backstop savepoint couldn't be made.", failure);
        } finally {
            DataSourceUtils.releaseConnection(connection, dataSource);
        }
    }

    @Override
    public List<PreviewChange> changes() {
        return changes.changes();
    }

    @Override
    public boolean changesTruncated() {
        return changes.truncated();
    }

    /**
     * Flushes, checks the MySQL backstop savepoint, then rolls back. Fails when the handler was refused something, the
     * savepoint is gone (something committed the transaction) or the flush failed; the rollback runs either way.
     */
    @Override
    public void rollback() {
        guard.finishing();
        RuntimeException flushFailure = null;
        IllegalStateException ended = null;
        try {
            // Once the database rolled the transaction back, nothing more may run in it: no final flush.
            if (!status.isCompleted() && !status.isRollbackOnly() && !guard.lost()) {
                try {
                    flush();
                } catch (RuntimeException failure) {
                    flushFailure = failure;
                }
            }
            if (savepoint != null && !status.isCompleted()) {
                try {
                    savepoint.verify();
                } catch (IllegalStateException failure) {
                    ended = failure;
                }
            }
        } finally {
            if (!status.isCompleted()) {
                transactions.rollback(status);
            }
        }
        if (guard.violation() != null) {
            throw guard.violation();
        }
        if (ended != null) {
            throw ended;
        }
        if (flushFailure != null) {
            throw flushFailure;
        }
        if (!status.isCompleted()) {
            throw new IllegalStateException("The preview transaction did not complete its rollback.");
        }
    }

    /** Flushes the persistence context bound to the preview transaction, translating JPA exceptions as Spring does. */
    private void flush() {
        if (entityManagerFactory == null) {
            return;
        }
        EntityManager manager = EntityManagerFactoryUtils.getTransactionalEntityManager(entityManagerFactory);
        if (manager == null || !manager.isOpen() || !manager.isJoinedToTransaction()) {
            return;
        }
        try {
            manager.flush();
        } catch (RuntimeException failure) {
            // The same translation JpaTransactionManager applies at commit: Hibernate's constraint violations become
            // DataIntegrityViolationException, which host error handling already knows.
            DataAccessException translated = transactions instanceof JpaTransactionManager jpa
                    ? jpa.getJpaDialect().translateExceptionIfPossible(failure) : null;
            if (translated == null) {
                translated = EntityManagerFactoryUtils.convertJpaAccessExceptionIfPossible(failure);
            }
            throw translated != null ? translated : failure;
        }
    }

    @Override
    public void close() {
        guard.finishing();
        try {
            if (!status.isCompleted()) {
                transactions.rollback(status);
            }
        } finally {
            guard.close();
            changes.close();
        }
    }
}
