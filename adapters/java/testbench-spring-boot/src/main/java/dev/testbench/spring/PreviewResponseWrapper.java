package dev.testbench.spring;

import com.fasterxml.jackson.databind.JsonNode;
import dev.testbench.core.CaptureLimits;
import dev.testbench.core.CapturedBodies;
import dev.testbench.core.CapturedResponse;
import dev.testbench.core.PreviewResponseTooLargeException;
import jakarta.servlet.ServletOutputStream;
import jakarta.servlet.WriteListener;
import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.servlet.http.HttpServletResponseWrapper;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStreamWriter;
import java.io.PrintWriter;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * An in-memory response used while previewing. Nothing the handler does here reaches the real response: the status,
 * headers, cookies and body are buffered (up to 1 MiB) until the rollback is confirmed.
 */
final class PreviewResponseWrapper extends HttpServletResponseWrapper implements CapturedResponse {
    private final Map<String, List<String>> headers = new LinkedHashMap<>();
    private final Map<String, String> names = new LinkedHashMap<>();
    private final ByteArrayOutputStream body = new ByteArrayOutputStream();
    private int status = HttpServletResponse.SC_OK;
    private String contentType;
    private String characterEncoding;
    private Locale locale = Locale.getDefault();
    private boolean exceeded;
    private boolean committed;
    private boolean writerUsed;
    private boolean streamUsed;
    private PrintWriter writer;

    PreviewResponseWrapper(HttpServletResponse response) {
        super(response);
        setHeader("Cache-Control", "no-store");
    }

    // ---- CapturedResponse -------------------------------------------------------------------------------------

    @Override
    public int status() {
        return status;
    }

    @Override
    public Map<String, List<String>> headers() {
        var result = new LinkedHashMap<String, List<String>>();
        for (var entry : headers.entrySet()) {
            result.put(names.get(entry.getKey()), List.copyOf(entry.getValue()));
        }
        String type = getContentType();
        if (type != null && !headers.containsKey("content-type")) {
            result.put("Content-Type", List.of(type));
        }
        return result;
    }

    @Override
    public JsonNode body() {
        flushWriter();
        return CapturedBodies.decode(body.toByteArray(), getContentType(), charset());
    }

    @Override
    public boolean exceededLimit() {
        return exceeded;
    }

    private Charset charset() {
        try {
            if (characterEncoding != null) {
                return Charset.forName(characterEncoding);
            }
        } catch (RuntimeException error) {
            // Fall through to the default.
        }
        return writerUsed ? StandardCharsets.ISO_8859_1 : StandardCharsets.UTF_8;
    }

    private void flushWriter() {
        if (writer != null) {
            writer.flush();
        }
    }

    // ---- status -----------------------------------------------------------------------------------------------

    @Override
    public void setStatus(int sc) {
        if (!committed) {
            status = sc;
        }
    }

    @Override
    public int getStatus() {
        return status;
    }

    @Override
    public void sendError(int sc, String message) {
        sendError(sc);
    }

    @Override
    public void sendError(int sc) {
        status = sc;
        body.reset();
        committed = true;
    }

    @Override
    public void sendRedirect(String location) {
        status = HttpServletResponse.SC_FOUND;
        setHeader("Location", location);
        body.reset();
        committed = true;
    }

    // ---- headers ----------------------------------------------------------------------------------------------

    @Override
    public void setHeader(String name, String value) {
        if (committed || name == null) {
            return;
        }
        String key = name.toLowerCase(Locale.ROOT);
        if (value == null) {
            headers.remove(key);
            return;
        }
        if (key.equals("content-type")) {
            setContentType(value);
            return;
        }
        names.putIfAbsent(key, name);
        var values = new ArrayList<String>();
        values.add(value);
        headers.put(key, values);
    }

    @Override
    public void addHeader(String name, String value) {
        if (committed || name == null || value == null) {
            return;
        }
        String key = name.toLowerCase(Locale.ROOT);
        if (key.equals("content-type")) {
            setContentType(value);
            return;
        }
        names.putIfAbsent(key, name);
        headers.computeIfAbsent(key, ignored -> new ArrayList<>()).add(value);
    }

    @Override
    public void setIntHeader(String name, int value) {
        setHeader(name, Integer.toString(value));
    }

    @Override
    public void addIntHeader(String name, int value) {
        addHeader(name, Integer.toString(value));
    }

    @Override
    public void setDateHeader(String name, long date) {
        setHeader(name, http(date));
    }

    @Override
    public void addDateHeader(String name, long date) {
        addHeader(name, http(date));
    }

    private static String http(long millis) {
        return DateTimeFormatter.RFC_1123_DATE_TIME.format(Instant.ofEpochMilli(millis).atOffset(ZoneOffset.UTC));
    }

    @Override
    public boolean containsHeader(String name) {
        String key = name.toLowerCase(Locale.ROOT);
        return headers.containsKey(key) || (key.equals("content-type") && contentType != null);
    }

    @Override
    public String getHeader(String name) {
        String key = name.toLowerCase(Locale.ROOT);
        if (key.equals("content-type")) {
            return getContentType();
        }
        List<String> values = headers.get(key);
        return values == null || values.isEmpty() ? null : values.get(0);
    }

    @Override
    public Collection<String> getHeaders(String name) {
        String key = name.toLowerCase(Locale.ROOT);
        if (key.equals("content-type")) {
            return contentType == null ? List.of() : List.of(getContentType());
        }
        List<String> values = headers.get(key);
        return values == null ? List.of() : List.copyOf(values);
    }

    @Override
    public Collection<String> getHeaderNames() {
        var result = new ArrayList<String>();
        for (String key : headers.keySet()) {
            result.add(names.get(key));
        }
        if (contentType != null) {
            result.add("Content-Type");
        }
        return result;
    }

    @Override
    public void addCookie(Cookie cookie) {
        // Cookies are recorded as a header so a handler's own inspection works, but they never leave the preview.
        addHeader("Set-Cookie", cookie.getName() + "=" + cookie.getValue());
    }

    // ---- content ----------------------------------------------------------------------------------------------

    @Override
    public void setContentType(String type) {
        if (committed || type == null) {
            return;
        }
        int charset = type.toLowerCase(Locale.ROOT).indexOf("charset=");
        if (charset >= 0) {
            String value = type.substring(charset + "charset=".length()).split(";", 2)[0].trim();
            if (!value.isEmpty()) {
                characterEncoding = value.replace("\"", "");
            }
            this.contentType = type.substring(0, charset).replaceAll("[;\\s]+$", "");
        } else {
            this.contentType = type;
        }
    }

    @Override
    public String getContentType() {
        if (contentType == null) {
            return null;
        }
        return characterEncoding == null ? contentType : contentType + ";charset=" + characterEncoding;
    }

    @Override
    public void setCharacterEncoding(String encoding) {
        if (!committed && !writerUsed) {
            characterEncoding = encoding;
        }
    }

    @Override
    public String getCharacterEncoding() {
        return characterEncoding != null ? characterEncoding : StandardCharsets.ISO_8859_1.name();
    }

    @Override
    public void setContentLength(int length) {
        // Computed by the real response when the envelope is written.
    }

    @Override
    public void setContentLengthLong(long length) {
        // Computed by the real response when the envelope is written.
    }

    @Override
    public void setLocale(Locale locale) {
        this.locale = locale;
    }

    @Override
    public Locale getLocale() {
        return locale;
    }

    @Override
    public ServletOutputStream getOutputStream() {
        if (writerUsed) {
            throw new IllegalStateException("getWriter() was already called.");
        }
        streamUsed = true;
        return new BoundedOutput();
    }

    @Override
    public PrintWriter getWriter() {
        if (streamUsed) {
            throw new IllegalStateException("getOutputStream() was already called.");
        }
        if (writer == null) {
            writerUsed = true;
            writer = new PrintWriter(new OutputStreamWriter(new BoundedOutput(), charset()), false);
        }
        return writer;
    }

    @Override
    public void flushBuffer() {
        flushWriter();
    }

    @Override
    public void resetBuffer() {
        flushWriter();
        body.reset();
    }

    @Override
    public void reset() {
        resetBuffer();
        headers.clear();
        names.clear();
        status = HttpServletResponse.SC_OK;
        contentType = null;
        characterEncoding = null;
        committed = false;
        setHeader("Cache-Control", "no-store");
    }

    @Override
    public boolean isCommitted() {
        return committed;
    }

    @Override
    public int getBufferSize() {
        return CaptureLimits.RESPONSE_BYTES;
    }

    @Override
    public void setBufferSize(int size) {
        // The preview always buffers up to its cap.
    }

    @Override
    public String encodeURL(String url) {
        return url;
    }

    @Override
    public String encodeRedirectURL(String url) {
        return url;
    }

    @Override
    public void setTrailerFields(java.util.function.Supplier<Map<String, String>> supplier) {
        // Trailers are not part of a preview.
    }

    private final class BoundedOutput extends ServletOutputStream {
        @Override
        public void write(int value) throws IOException {
            check(1);
            body.write(value);
        }

        @Override
        public void write(byte[] bytes, int offset, int length) throws IOException {
            check(length);
            body.write(bytes, offset, length);
        }

        private void check(int length) throws IOException {
            if ((long) body.size() + length > CaptureLimits.RESPONSE_BYTES) {
                exceeded = true;
                throw new PreviewResponseTooLargeException();
            }
        }

        @Override
        public boolean isReady() {
            return true;
        }

        @Override
        public void setWriteListener(WriteListener listener) {
            throw new IllegalStateException("Test Bench previews run synchronously.");
        }
    }
}
