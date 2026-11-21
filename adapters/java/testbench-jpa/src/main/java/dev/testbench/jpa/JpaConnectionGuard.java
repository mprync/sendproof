package dev.testbench.jpa;

import java.sql.Connection;
import net.ttddyy.dsproxy.listener.MethodExecutionContext;
import net.ttddyy.dsproxy.listener.MethodExecutionListener;

/**
 * Refuses a handler's own {@code Connection.commit()} or {@code setAutoCommit(true)} while a preview's handler runs on
 * the thread, for example {@code DataSourceUtils.getConnection(dataSource).commit()} or a Hibernate {@code doWork}
 * callback. Either would commit the work the preview must roll back. Spring joins every {@code @Transactional} call to
 * the preview's transaction, so no legitimate commit happens while the handler runs. Outside a preview it does nothing.
 */
final class JpaConnectionGuard implements MethodExecutionListener {

    @Override
    public void beforeMethod(MethodExecutionContext context) {
        if (!(context.getTarget() instanceof Connection) || !PreviewTransactionGuard.isHandling()) {
            return;
        }
        String name = context.getMethod().getName();
        Object[] args = context.getMethodArgs();
        RuntimeException refusal = null;
        if (name.equals("commit")) {
            refusal = PreviewTransactionGuard.refuseWhileHandling("Connection.commit()");
        } else if (name.equals("setAutoCommit") && args != null && args.length == 1 && Boolean.TRUE.equals(args[0])) {
            refusal = PreviewTransactionGuard.refuseWhileHandling("Connection.setAutoCommit(true)");
        }
        if (refusal != null) {
            throw refusal;
        }
    }

    @Override
    public void afterMethod(MethodExecutionContext context) {
        // Nothing to do.
    }
}
