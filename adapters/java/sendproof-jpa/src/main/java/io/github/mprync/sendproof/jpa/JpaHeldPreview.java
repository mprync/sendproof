package io.github.mprync.sendproof.jpa;

import io.github.mprync.sendproof.core.DatabaseSystem;
import io.github.mprync.sendproof.core.HeldPreview;
import io.github.mprync.sendproof.core.PreviewChange;
import io.github.mprync.sendproof.core.PreviewSavepoint;
import io.github.mprync.sendproof.core.RequestCapture;
import jakarta.persistence.EntityManagerFactory;
import java.sql.Connection;
import java.sql.SQLException;
import java.util.List;
import java.util.Set;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionSynchronizationManager;

/** Keeps one JDBC transaction between requests, with a new Spring transaction and persistence context per step. */
final class JpaHeldPreview implements HeldPreview {
    private final PlatformTransactionManager transactions;
    private final EntityManagerFactory entities;
    private final CaptureDataSource dataSource;
    private final Connection physical;
    private final String system;
    private final Set<String> safeProcedures;
    private final Runnable releaseTurn;
    private PreviewSavepoint stepStart;
    private long sequence;
    private boolean closed;

    JpaHeldPreview(PlatformTransactionManager transactions, EntityManagerFactory entities, CaptureDataSource dataSource,
                   String system, Set<String> safeProcedures, Runnable releaseTurn) throws SQLException {
        this.transactions = transactions;
        this.entities = entities;
        this.dataSource = dataSource;
        this.system = system;
        this.safeProcedures = safeProcedures;
        this.releaseTurn = releaseTurn;
        physical = dataSource.openPhysical();
        try {
            String actual = DatabaseSystem.of(physical.getMetaData().getDatabaseProductName());
            if (!system.equals(actual)) {
                throw new SQLException("The Preview DataSource's database does not match its advertised system.");
            }
            PreviewSavepoint.beginHeld(physical, system);
        } catch (SQLException | RuntimeException | Error failure) {
            try {
                physical.close();
            } catch (SQLException cleanup) {
                failure.addSuppressed(cleanup);
            }
            throw failure;
        }
    }

    private PreviewSavepoint newSavepoint() throws SQLException {
        return PreviewSavepoint.open(physical, system, PreviewSavepoint.NAME + "_" + ++sequence);
    }

    @Override
    public Checkpoint checkpoint() throws UnsafeTransaction, TransactionEnded {
        try {
            stepStart = newSavepoint();
            stepStart.check();
        } catch (SQLException failure) {
            throw probeFailure("The held Preview checkpoint could not be created.", failure);
        }
        PreviewSavepoint point = stepStart;
        return new Checkpoint() {
            @Override
            public void rollback() throws UnsafeTransaction, TransactionEnded {
                rewind(point);
            }

            @Override
            public void discard() throws UnsafeTransaction, TransactionEnded {
                release(point);
            }
        };
    }

    @Override
    public Step begin(RequestCapture capture) throws UnsafeTransaction, TransactionEnded {
        if (stepStart == null || TransactionSynchronizationManager.isSynchronizationActive()
                || TransactionSynchronizationManager.isActualTransactionActive()
                || TransactionSynchronizationManager.hasResource(dataSource)
                || entities != null && TransactionSynchronizationManager.hasResource(entities)) {
            throw new UnsafeTransaction("A held Preview step needs a checkpoint and an unbound Spring request thread.",
                    null);
        }
        PreviewSavepoint start = stepStart;
        stepStart = null;
        PreviewSavepoint sentinel;
        try {
            sentinel = newSavepoint();
        } catch (SQLException failure) {
            throw probeFailure("The held Preview step savepoint could not be created.", failure);
        }
        PinnedConnection pinned = new PinnedConnection(dataSource, physical);
        JpaPreviewSession session;
        try {
            session = new JpaPreviewSession(transactions, entities, system, safeProcedures, pinned);
        } catch (RuntimeException | Error failure) {
            pinned.close();
            throw new UnsafeTransaction("Spring could not enroll in the held Preview transaction.", failure);
        }
        return new Step() {
            private boolean springRollbackOnly;

            @Override
            public void finish() throws SQLException, UnsafeTransaction, TransactionEnded {
                springRollbackOnly = !session.finishHeld();
                if ("postgresql".equals(system) && !springRollbackOnly) {
                    try {
                        start.check();
                    } catch (SQLException failure) {
                        if (isPostgresAborted(failure)) {
                            throw failure;
                        }
                        throw probeFailure("The held Preview transaction could not be checked.", failure);
                    }
                }
            }

            @Override
            public List<PreviewChange> changes() {
                return session.changes();
            }

            @Override
            public boolean changesTruncated() {
                return session.changesTruncated();
            }

            @Override
            public void close() throws UnsafeTransaction, TransactionEnded {
                try {
                    session.close();
                } catch (RuntimeException failure) {
                    session.checkHeldGuard();
                    throw new UnsafeTransaction("Spring could not clean up the held Preview step.", failure);
                } finally {
                    pinned.close();
                }
                session.checkHeldGuard();
                try {
                    sentinel.release();
                    if (springRollbackOnly) {
                        rewind(start);
                    }
                    start.check();
                } catch (SQLException failure) {
                    if (isPostgresAborted(failure)) {
                        // PostgreSQL refuses RELEASE until a rollback to an earlier savepoint clears the abort.
                        rewind(start);
                        return;
                    }
                    throw probeFailure("The held Preview transaction could not be checked.", failure);
                }
            }
        };
    }

    private boolean isPostgresAborted(SQLException failure) {
        return "postgresql".equals(system) && "25P02".equals(failure.getSQLState());
    }

    private void rewind(PreviewSavepoint point) throws UnsafeTransaction, TransactionEnded {
        try {
            point.rollback();
        } catch (SQLException failure) {
            throw probeFailure("The held Preview checkpoint could not be rolled back.", failure);
        }
    }

    private void release(PreviewSavepoint point) throws UnsafeTransaction, TransactionEnded {
        try {
            point.release();
        } catch (SQLException failure) {
            throw probeFailure("The held Preview savepoint could not be released.", failure);
        }
    }

    private static UnsafeTransaction probeFailure(String message, SQLException failure) throws TransactionEnded {
        String state = failure.getSQLState();
        if (state != null && state.startsWith("08")) {
            throw new TransactionEnded("The database connection for the held Preview ended.", failure);
        }
        return new UnsafeTransaction(message, failure);
    }

    @Override
    public void close() throws SQLException {
        if (closed) {
            return;
        }
        closed = true;
        try (Connection connection = physical) {
            connection.rollback();
        } finally {
            releaseTurn.run();
        }
    }
}
