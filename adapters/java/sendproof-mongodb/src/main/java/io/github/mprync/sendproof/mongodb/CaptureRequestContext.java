package io.github.mprync.sendproof.mongodb;

import com.mongodb.RequestContext;
import io.github.mprync.sendproof.core.RequestCapture;
import java.util.HashMap;
import java.util.Map;
import java.util.stream.Stream;

/**
 * The driver's per-operation context, carrying the capture of the request that started the operation. The reactive
 * driver reports command events on its own threads, so the capture cannot be found on the thread-local there; the
 * context provider reads it where the operation is subscribed instead.
 */
final class CaptureRequestContext implements RequestContext {
    private final Map<Object, Object> values = new HashMap<>();
    private final RequestCapture capture;
    private final boolean internal;
    private final boolean attributed;

    CaptureRequestContext(RequestCapture capture, boolean internal, boolean attributed) {
        this.capture = capture;
        this.internal = internal;
        this.attributed = attributed;
    }

    /** Whether the operation started inside a request, or work declared detached. */
    boolean attributed() {
        return attributed || capture != null;
    }

    /** The capture current where the operation started, or {@code null}. */
    RequestCapture capture() {
        return capture;
    }

    /** Whether the engine itself started the operation. */
    boolean internal() {
        return internal;
    }

    @Override
    public <T> T get(Object key) {
        return getOrDefault(key, null);
    }

    @Override
    @SuppressWarnings("unchecked")
    public <T> T getOrDefault(Object key, T fallback) {
        return values.containsKey(key) ? (T) values.get(key) : fallback;
    }

    @Override
    public boolean hasKey(Object key) {
        return values.containsKey(key);
    }

    @Override
    public boolean isEmpty() {
        return values.isEmpty();
    }

    @Override
    public void put(Object key, Object value) {
        values.put(key, value);
    }

    @Override
    public void putNonNull(Object key, Object value) {
        if (value != null) {
            values.put(key, value);
        }
    }

    @Override
    public void delete(Object key) {
        values.remove(key);
    }

    @Override
    public int size() {
        return values.size();
    }

    @Override
    public Stream<Map.Entry<Object, Object>> stream() {
        return values.entrySet().stream();
    }
}
