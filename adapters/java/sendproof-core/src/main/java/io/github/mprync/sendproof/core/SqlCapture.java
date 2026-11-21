package io.github.mprync.sendproof.core;

import io.github.mprync.sendproof.core.CaptureModels.CapturedSql;
import io.github.mprync.sendproof.core.CaptureModels.SqlParameter;
import io.github.mprync.sendproof.core.RequestCapture.SqlSnapshot;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;

/** Builds bounded, redacted {@link CapturedSql} entries from raw SQL text and bound values. */
public final class SqlCapture {
    /** The log category used for SQL entries. */
    public static final String CATEGORY = "io.github.mprync.sendproof.sql";

    private SqlCapture() {
    }

    /** A bound value as reported by the data layer. */
    public record Binding(Object value, String dbType) {
    }

    /**
     * Snapshots one command.
     *
     * @param sql          the statement text
     * @param bindings     the bound values in placeholder order
     * @param rowsAffected the update count, or {@code null} when unknown
     * @param showValues   whether values may be shown; otherwise every value is redacted
     */
    public static SqlSnapshot snapshot(String sql, List<Binding> bindings, Integer rowsAffected, boolean showValues) {
        String text = CaptureLimits.clip(sql);
        boolean truncated = text.length() != sql.length() || bindings.size() > CaptureLimits.PARAMETERS;
        // Generated placeholders carry no column information. If the statement names a secret anywhere, hide every
        // value in it: inferring which binding a fragment of SQL refers to is not safe.
        boolean redactStatement = showValues && SqlRedaction.looksSecret(sql);
        List<String> names = SqlParameterNames.infer(sql);
        var parameters = new ArrayList<SqlParameter>();
        for (int i = 0; i < Math.min(bindings.size(), CaptureLimits.PARAMETERS); i++) {
            String name = i < names.size() ? names.get(i) : "p" + (i + 1);
            Binding binding = bindings.get(i);
            boolean redact = !showValues || redactStatement || SqlRedaction.looksSecret(name);
            String value;
            if (redact) {
                value = SqlRedaction.REDACTED;
            } else {
                String[] converted = new String[1];
                truncated |= convert(binding.value(), converted);
                value = converted[0];
            }
            parameters.add(new SqlParameter(CaptureLimits.clip(name, CaptureLimits.NAME), value,
                    binding.dbType() == null ? "OTHER" : binding.dbType()));
        }
        return new SqlSnapshot(new CapturedSql(text, List.copyOf(parameters), rowsAffected), truncated);
    }

    private static boolean convert(Object value, String[] out) {
        if (value == null) {
            out[0] = null;
            return false;
        }
        if (value instanceof byte[] bytes) {
            int length = Math.min(bytes.length, CaptureLimits.TEXT / 2);
            out[0] = HexFormat.of().withUpperCase().formatHex(bytes, 0, length);
            return length < bytes.length;
        }
        String original = String.valueOf(value);
        out[0] = CaptureLimits.clip(original);
        return out[0].length() != original.length();
    }
}
