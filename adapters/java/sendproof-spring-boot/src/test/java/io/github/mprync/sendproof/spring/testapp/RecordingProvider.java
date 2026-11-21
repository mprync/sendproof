package io.github.mprync.sendproof.spring.testapp;

import io.github.mprync.sendproof.core.PreviewChange;
import io.github.mprync.sendproof.core.PreviewObservation;
import io.github.mprync.sendproof.core.PreviewProvider;
import io.github.mprync.sendproof.core.PreviewSession;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import org.springframework.stereotype.Component;

/** A preview provider that counts its lifecycle so tests can assert rollback and disposal. */
@Component
public class RecordingProvider implements PreviewProvider {
    public final AtomicInteger begun = new AtomicInteger();
    public final AtomicInteger rolledBack = new AtomicInteger();
    public final AtomicInteger closed = new AtomicInteger();
    public volatile boolean failBegin;
    public volatile boolean failRollback;

    public void reset() {
        begun.set(0);
        rolledBack.set(0);
        closed.set(0);
        failBegin = false;
        failRollback = false;
    }

    @Override
    public boolean isAvailable() {
        return true;
    }

    @Override
    public String database() {
        return "Fake DB";
    }

    @Override
    public PreviewSession begin() {
        if (failBegin) {
            throw new IllegalStateException("no connection");
        }
        begun.incrementAndGet();
        return new PreviewSession() {
            @Override
            public List<PreviewChange> changes() {
                return List.of(new PreviewChange("insert", "things", Map.of("id", 1), null, Map.of("id", 1)));
            }

            @Override
            public void rollback() {
                rolledBack.incrementAndGet();
                if (failRollback) {
                    throw new IllegalStateException("injected");
                }
            }

            @Override
            public void close() {
                closed.incrementAndGet();
            }
        };
    }

    @Override
    public PreviewObservation beginObservation() {
        return new PreviewObservation() {
            @Override
            public List<PreviewChange> changes() {
                return List.of(new PreviewChange("update", "things", Map.of("id", 2), Map.of("n", 1), Map.of("n", 2)));
            }

            @Override
            public void close() {
            }
        };
    }
}
