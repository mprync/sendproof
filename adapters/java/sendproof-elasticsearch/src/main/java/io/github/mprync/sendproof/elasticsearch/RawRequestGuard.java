package io.github.mprync.sendproof.elasticsearch;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.List;
import org.apache.http.HttpEntityEnclosingRequest;
import org.apache.http.HttpRequest;
import org.apache.http.HttpRequestInterceptor;
import org.apache.http.protocol.HttpContext;
import org.apache.http.util.EntityUtils;

/**
 * Guards a low-level Elasticsearch {@code RestClient}: the first request interceptor of its HTTP client, which the client
 * runs on the calling thread before it opens or reuses a connection. A request the guarded transport already checked
 * carries {@link #CHECKED} and passes; any other request (a raw {@code performRequest}) is classified by its method, path
 * and body like a typed one, and a write is refused before it is sent during a Preview (and, while one is open, on a
 * thread no request owns).
 */
final class RawRequestGuard implements HttpRequestInterceptor {
    /** The header the guarded transport adds to every request it has checked. */
    static final String CHECKED = "X-Sendproof-Checked";

    private final ElasticsearchStore store;

    RawRequestGuard(ElasticsearchStore store) {
        this.store = store;
    }

    @Override
    public void process(HttpRequest request, HttpContext context) throws IOException {
        if (request.containsHeader(CHECKED)) {
            return;
        }
        String method = request.getRequestLine().getMethod();
        String path = path(request.getRequestLine().getUri());
        SearchSupport.begin(store, method, path, () -> lines(request)).complete(null, null);
    }

    /** The path of a request line's URI, which may be absolute, without its query string. */
    static String path(String uri) {
        int scheme = uri.indexOf("://");
        if (scheme >= 0) {
            int slash = uri.indexOf('/', scheme + 3);
            uri = slash < 0 ? "/" : uri.substring(slash);
        }
        int query = uri.indexOf('?');
        return query < 0 ? uri : uri.substring(0, query);
    }

    /** The body as NDJSON lines, or empty when there is none or it can't be read twice. */
    private static List<String> lines(HttpRequest request) {
        if (!(request instanceof HttpEntityEnclosingRequest enclosing) || enclosing.getEntity() == null
                || !enclosing.getEntity().isRepeatable()) {
            return List.of();
        }
        try {
            return Arrays.asList(EntityUtils.toString(enclosing.getEntity(), StandardCharsets.UTF_8).split("\n"));
        } catch (IOException | RuntimeException unreadable) {
            return List.of();
        }
    }
}
