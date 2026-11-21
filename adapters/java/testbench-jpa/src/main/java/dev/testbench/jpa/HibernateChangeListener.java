package dev.testbench.jpa;

import dev.testbench.core.CaptureLimits;
import dev.testbench.core.PreviewChange;
import java.util.LinkedHashMap;
import java.util.Map;
import org.hibernate.engine.spi.SessionImplementor;
import org.hibernate.event.spi.EventSource;
import org.hibernate.event.spi.PostDeleteEvent;
import org.hibernate.event.spi.PostDeleteEventListener;
import org.hibernate.event.spi.PostInsertEvent;
import org.hibernate.event.spi.PostInsertEventListener;
import org.hibernate.event.spi.PostUpdateEvent;
import org.hibernate.event.spi.PostUpdateEventListener;
import org.hibernate.persister.entity.EntityPersister;
import org.hibernate.type.Type;

/**
 * Turns Hibernate's post-insert, post-update and post-delete events into before/after snapshots for the request that is
 * currently being previewed or observed. The events fire when SQL executes at flush, inside the open transaction, so a
 * rolled-back preview still reports what it would have written.
 *
 * <p>Only entity writes are visible here. Bulk JPQL/native statements and plain JDBC writes appear as SQL log entries,
 * not as row changes.
 */
final class HibernateChangeListener
        implements PostInsertEventListener, PostUpdateEventListener, PostDeleteEventListener {
    private static final long serialVersionUID = 1L;

    @Override
    public void onPostInsert(PostInsertEvent event) {
        record("insert", event.getPersister(), event.getId(), event.getSession(), null, event.getState());
    }

    @Override
    public void onPostUpdate(PostUpdateEvent event) {
        record("update", event.getPersister(), event.getId(), event.getSession(), event.getOldState(), event.getState());
    }

    @Override
    public void onPostDelete(PostDeleteEvent event) {
        record("delete", event.getPersister(), event.getId(), event.getSession(), event.getDeletedState(), null);
    }

    @Override
    public boolean requiresPostCommitHandling(EntityPersister persister) {
        // Capture at flush so a rolled-back preview still sees its changes.
        return false;
    }

    private static void record(String operation, EntityPersister persister, Object id, EventSource session,
                               Object[] before, Object[] after) {
        ChangeLog log = ChangeLog.current();
        if (log == null) {
            return;
        }
        try {
            boolean[] clipped = new boolean[1];
            String idName = persister.getIdentifierPropertyName() == null ? "id" : persister.getIdentifierPropertyName();
            Map<String, Object> key = new LinkedHashMap<>();
            key.put(idName, value(id, null, session, clipped));
            log.add(new PreviewChange(operation, tableName(persister), key,
                    before == null ? null : row(persister, idName, id, before, session, clipped),
                    after == null ? null : row(persister, idName, id, after, session, clipped)), clipped[0]);
        } catch (RuntimeException error) {
            // Capture must never interrupt the application.
            log.add(new PreviewChange(operation, persister.getEntityName(), null, null, null), true);
        }
    }

    private static String tableName(EntityPersister persister) {
        return persister.getMappedTableDetails().getTableName();
    }

    private static Map<String, Object> row(EntityPersister persister, String idName, Object id, Object[] state,
                                           SessionImplementor session, boolean[] clipped) {
        var row = new LinkedHashMap<String, Object>();
        row.put(idName, value(id, null, session, clipped));
        String[] names = persister.getPropertyNames();
        Type[] types = persister.getPropertyTypes();
        for (int i = 0; i < names.length && i < state.length; i++) {
            if (types[i].isCollectionType()) {
                continue;
            }
            if (row.size() == CaptureLimits.PARAMETERS) {
                clipped[0] = true;
                break;
            }
            row.put(names[i], value(state[i], types[i], session, clipped));
        }
        return row;
    }

    private static Object value(Object value, Type type, SessionImplementor session, boolean[] clipped) {
        if (value == null) {
            return null;
        }
        if (type != null && type.isEntityType()) {
            // A reference is shown as the referenced row's key, never as the whole entity graph.
            return session.getContextEntityIdentifier(value);
        }
        if (value instanceof String text) {
            String result = CaptureLimits.clip(text);
            clipped[0] |= result.length() != text.length();
            return result;
        }
        if (value instanceof byte[] bytes) {
            int length = Math.min(bytes.length, CaptureLimits.TEXT * 3 / 4);
            clipped[0] |= length < bytes.length;
            return java.util.Arrays.copyOf(bytes, length);
        }
        return value;
    }
}
