package dev.testbench.core;

import com.fasterxml.jackson.databind.JsonNode;
import dev.testbench.core.CaptureModels.CaptureSnapshot;
import dev.testbench.core.CaptureModels.CaptureTiming;
import dev.testbench.core.CaptureModels.CapturedException;
import dev.testbench.core.CaptureModels.CapturedSql;
import dev.testbench.core.CaptureModels.PreviewEffect;
import dev.testbench.core.CaptureModels.PreviewLog;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.function.Supplier;

/**
 * Collects the effects, logs and SQL timing of one request. It is inactive until {@link #begin} is called and is
 * bounded by {@link CaptureLimits}. All members are thread safe.
 */
public final class RequestCapture {
    private final Object gate = new Object();
    private final List<PreviewEffect> effects = new ArrayList<>();
    private final List<PreviewLog> logs = new ArrayList<>();
    private boolean active;
    private boolean rollback;
    private boolean logsTruncated;
    private boolean effectsTruncated;
    private int logSize;
    private int effectSize;
    private long requestStart;
    private double dbMs;
    private int queries;
    private double serializeMs;

    /** Returns whether a rollback-only preview is capturing. */
    public boolean isPreview() {
        synchronized (gate) {
            return active && rollback;
        }
    }

    /** Returns whether anything is capturing (a preview or an observed send). */
    public boolean isActive() {
        synchronized (gate) {
            return active;
        }
    }

    /**
     * Starts capturing.
     *
     * @param rollback     {@code true} for a rollback-only preview, {@code false} for an observed send
     * @param requestStart the request start as a {@link System#nanoTime()} value
     */
    public void begin(boolean rollback, long requestStart) {
        synchronized (gate) {
            this.requestStart = requestStart;
            this.rollback = rollback;
            this.active = true;
        }
    }

    /**
     * Records an effect.
     *
     * @return {@code true} when the host must suppress delivery (a preview); {@code false} when it should proceed
     */
    public boolean tryRecordEffect(String kind, String description, Object data) {
        synchronized (gate) {
            if (!active) {
                return false;
            }
            if (effects.size() == CaptureLimits.EFFECTS || effectSize >= CaptureLimits.LOG_BUDGET) {
                effectsTruncated = true;
                return rollback;
            }
            long started = System.nanoTime();
            JsonNode captured = data == null ? null : CaptureLimits.snapshot(data);
            serializeMs += (System.nanoTime() - started) / 1_000_000.0;
            String capturedKind = CaptureLimits.clip(kind, CaptureLimits.NAME);
            String capturedDescription = CaptureLimits.clip(description);
            effectSize += capturedKind.length() + capturedDescription.length() + CaptureLimits.size(captured);
            effectsTruncated |= !capturedKind.equals(kind) || !capturedDescription.equals(description)
                    || (captured == null && data != null);
            if (effectSize <= CaptureLimits.LOG_BUDGET) {
                effects.add(new PreviewEffect(capturedKind, capturedDescription, captured, rollback ? null : Boolean.TRUE));
            } else {
                effectsTruncated = true;
            }
            return rollback;
        }
    }

    /** Records an explicit log message; returns whether a capture is active. */
    public boolean tryRecordLog(String level, String message) {
        synchronized (gate) {
            if (!active) {
                return false;
            }
            if (hasLogRoom()) {
                addLog(new PreviewLog(clip(level, CaptureLimits.NAME), clip(message, CaptureLimits.TEXT), null, null,
                        offsetMs(), null, null, null, null));
            }
            return true;
        }
    }

    /** Records a structured log produced by a logging framework. */
    public void log(String category, String level, String message, Map<String, String> properties,
                    String exceptionType, String exceptionMessage) {
        synchronized (gate) {
            if (!active || !hasLogRoom()) {
                return;
            }
            try {
                Map<String, String> captured = null;
                if (properties != null && !properties.isEmpty()) {
                    captured = new java.util.LinkedHashMap<>();
                    for (var entry : properties.entrySet()) {
                        if (captured.size() == CaptureLimits.PROPERTIES) {
                            logsTruncated = true;
                            break;
                        }
                        captured.put(clip(entry.getKey(), CaptureLimits.NAME),
                                clip(String.valueOf(entry.getValue()), CaptureLimits.TEXT));
                    }
                }
                CapturedException exception = exceptionType == null ? null : new CapturedException(
                        clip(exceptionType, CaptureLimits.NAME), clip(String.valueOf(exceptionMessage), CaptureLimits.TEXT));
                addLog(new PreviewLog(level, clip(message, CaptureLimits.TEXT),
                        category == null ? null : clip(category, CaptureLimits.NAME), null, offsetMs(), null, captured,
                        exception, null));
            } catch (RuntimeException error) {
                logsTruncated = true;
            }
        }
    }

    /** The result of snapshotting one SQL command. */
    public record SqlSnapshot(CapturedSql sql, boolean truncated) {
    }

    /**
     * Records an executed SQL command: always counts it toward timing, and retains a log entry while there is room.
     *
     * @param durationMs how long the command ran
     * @param category   the log category
     * @param snapshot   builds the (possibly redacted) SQL snapshot; only called when there is room for it
     */
    public void recordSql(double durationMs, String category, Supplier<SqlSnapshot> snapshot) {
        synchronized (gate) {
            if (!active) {
                return;
            }
            dbMs += durationMs;
            queries = queries < Integer.MAX_VALUE ? queries + 1 : queries;
            if (!hasLogRoom()) {
                return;
            }
            try {
                SqlSnapshot captured = snapshot.get();
                logsTruncated |= captured.truncated();
                addLog(new PreviewLog("Sql", captured.sql().text(), category, null,
                        Math.max(0, offsetMs() - durationMs), durationMs, null, null, captured.sql()));
            } catch (RuntimeException error) {
                logsTruncated = true;
            }
        }
    }

    /** Reads the timing metrics for this request. */
    public CaptureTiming timing(CaptureClock clock, double extraSerializationMs) {
        synchronized (gate) {
            return clock.read(dbMs, queries, serializeMs, extraSerializationMs);
        }
    }

    /** Stops capturing and returns what was retained. */
    public CaptureSnapshot finish() {
        synchronized (gate) {
            active = false;
            var snapshot = new CaptureSnapshot(List.copyOf(effects), List.copyOf(logs), logsTruncated, effectsTruncated);
            effects.clear();
            logs.clear();
            return snapshot;
        }
    }

    private double offsetMs() {
        return (System.nanoTime() - requestStart) / 1_000_000.0;
    }

    private String clip(String value, int maximum) {
        String result = CaptureLimits.clip(value, maximum);
        logsTruncated |= result.length() != value.length();
        return result;
    }

    private boolean hasLogRoom() {
        boolean room = logs.size() < CaptureLimits.LOGS && logSize < CaptureLimits.LOG_BUDGET;
        logsTruncated |= !room;
        return room;
    }

    private void addLog(PreviewLog entry) {
        if (hasLogRoom()) {
            int size = entry.size();
            if (logSize + size <= CaptureLimits.LOG_BUDGET) {
                logs.add(entry);
                logSize += size;
            } else {
                logsTruncated = true;
            }
        }
    }
}
