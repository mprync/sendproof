package dev.testbench.jpa;

import dev.testbench.core.PreviewChange;
import dev.testbench.core.PreviewSession;
import jakarta.persistence.EntityManager;
import jakarta.persistence.EntityManagerFactory;
import java.util.List;
import org.springframework.dao.DataAccessException;
import org.springframework.orm.jpa.EntityManagerFactoryUtils;
import org.springframework.orm.jpa.JpaTransactionManager;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionStatus;
import org.springframework.transaction.support.DefaultTransactionDefinition;

/**
 * One preview's outer Spring transaction. Handler code that uses {@code @Transactional}, Spring Data repositories,
 * {@code JdbcTemplate} or an injected {@code EntityManager} joins it, so every write is part of one transaction that
 * is always rolled back. Pending entity changes are flushed before the rollback so their SQL runs, their
 * constraints are checked and their changes are captured.
 */
final class JpaPreviewSession implements PreviewSession {
    private final PlatformTransactionManager transactions;
    private final EntityManagerFactory entityManagerFactory;
    private final TransactionStatus status;
    private final ChangeLog changes;
    private final PreviewTransactionGuard.Scope guard;

    JpaPreviewSession(PlatformTransactionManager transactions, EntityManagerFactory entityManagerFactory) {
        this.transactions = transactions;
        this.entityManagerFactory = entityManagerFactory;
        this.changes = ChangeLog.open();
        this.guard = PreviewTransactionGuard.enter(this::flush);
        TransactionStatus started = null;
        try {
            started = transactions.getTransaction(new DefaultTransactionDefinition());
            guard.started();
        } catch (RuntimeException | Error failure) {
            // Nothing was acquired, or the begin failed part-way: release everything this constructor took.
            guard.close();
            changes.close();
            throw failure;
        }
        this.status = started;
    }

    @Override
    public List<PreviewChange> changes() {
        return changes.changes();
    }

    @Override
    public boolean changesTruncated() {
        return changes.truncated();
    }

    @Override
    public void rollback() {
        guard.finishing();
        RuntimeException flushFailure = null;
        try {
            if (!status.isCompleted() && !status.isRollbackOnly()) {
                try {
                    flush();
                } catch (RuntimeException failure) {
                    flushFailure = failure;
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
