package io.github.mprync.sendproof.jdbc;

import java.lang.reflect.Method;
import java.sql.Connection;
import net.ttddyy.dsproxy.listener.MethodExecutionContext;
import net.ttddyy.dsproxy.listener.MethodExecutionListener;

/**
 * Refuses JDBC calls that would end a preview's transaction when they reach its physical connection by a route that
 * bypasses {@link SharedConnection}, such as {@code statement.getConnection().commit()} or
 * {@code resultSet.getStatement().getConnection().close()}. Outside a preview it does nothing.
 */
final class PreviewConnectionGuard implements MethodExecutionListener {

    @Override
    public void beforeMethod(MethodExecutionContext context) {
        if (!(context.getTarget() instanceof Connection)) {
            return;
        }
        JdbcPreviewSession session = JdbcPreviewSession.owning(context.getTarget());
        if (session == null) {
            return;
        }
        Method method = context.getMethod();
        Object[] args = context.getMethodArgs();
        switch (method.getName()) {
            case "commit", "close", "abort", "unwrap" -> throw session.refuse("Connection." + method.getName() + "()");
            case "setAutoCommit" -> {
                if (args != null && args.length == 1 && Boolean.TRUE.equals(args[0])) {
                    throw session.refuse("Connection.setAutoCommit(true)");
                }
            }
            default -> {
                // Everything else keeps the transaction open.
            }
        }
    }

    @Override
    public void afterMethod(MethodExecutionContext context) {
        // Nothing to do.
    }
}
