package dev.testbench.spring;

import jakarta.servlet.AsyncContext;
import jakarta.servlet.ServletRequest;
import jakarta.servlet.ServletResponse;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.Enumeration;
import java.util.Locale;

/**
 * Presents a {@code /bench/_preview/...} request to the rest of the filter chain as the original operation request.
 * The path is rewritten (the method, query, headers other than caching and encoding, and body are untouched) so
 * routing, security and parameter binding run exactly as for a normal call. Asynchronous processing is unavailable
 * because the preview must finish inside the transaction it controls.
 */
final class PreviewRequestWrapper extends HttpServletRequestWrapper {
    private final String requestUri;
    private final String servletPath;
    private final String pathInfo;
    private final StringBuffer requestUrl;

    /**
     * Creates the wrapper.
     *
     * @param request   the original request
     * @param rewritten the mount-relative rewritten path, still percent-encoded
     */
    PreviewRequestWrapper(HttpServletRequest request, String rewritten) {
        super(request);
        this.requestUri = request.getContextPath() + rewritten;
        String decoded = URLDecoder.decode(rewritten.replace("+", "%2B"), StandardCharsets.UTF_8);
        String originalServletPath = request.getServletPath();
        if (request.getPathInfo() == null) {
            // Default servlet mapping ("/"): the whole path is the servlet path.
            this.servletPath = decoded;
            this.pathInfo = null;
        } else if (decoded.startsWith(originalServletPath)) {
            // Prefix mapping ("/api/*"): keep the mapped prefix and rewrite only what follows it.
            this.servletPath = originalServletPath;
            String rest = decoded.substring(originalServletPath.length());
            this.pathInfo = rest.isEmpty() ? null : rest;
        } else {
            this.servletPath = decoded;
            this.pathInfo = null;
        }
        StringBuffer original = request.getRequestURL();
        String originalUri = request.getRequestURI();
        this.requestUrl = new StringBuffer(original.substring(0, original.length() - originalUri.length()) + requestUri);
    }

    @Override
    public String getRequestURI() {
        return requestUri;
    }

    @Override
    public StringBuffer getRequestURL() {
        return new StringBuffer(requestUrl);
    }

    @Override
    public String getServletPath() {
        return servletPath;
    }

    @Override
    public String getPathInfo() {
        return pathInfo;
    }

    @Override
    public String getPathTranslated() {
        return null;
    }

    @Override
    public String getHeader(String name) {
        if (hidden(name)) {
            return null;
        }
        return name.equalsIgnoreCase("Cache-Control") ? "no-cache, no-store" : super.getHeader(name);
    }

    @Override
    public Enumeration<String> getHeaders(String name) {
        if (hidden(name)) {
            return Collections.emptyEnumeration();
        }
        return name.equalsIgnoreCase("Cache-Control")
                ? Collections.enumeration(Collections.singletonList("no-cache, no-store")) : super.getHeaders(name);
    }

    @Override
    public Enumeration<String> getHeaderNames() {
        var names = Collections.list(super.getHeaderNames());
        names.removeIf(PreviewRequestWrapper::hidden);
        if (names.stream().noneMatch(name -> name.equalsIgnoreCase("Cache-Control"))) {
            names.add("Cache-Control");
        }
        return Collections.enumeration(names);
    }

    // The preview buffers the whole response, so compressed bodies would only be noise.
    private static boolean hidden(String name) {
        return name.toLowerCase(Locale.ROOT).equals("accept-encoding");
    }

    @Override
    public boolean isAsyncSupported() {
        return false;
    }

    @Override
    public AsyncContext startAsync() {
        throw new IllegalStateException("Test Bench previews run synchronously.");
    }

    @Override
    public AsyncContext startAsync(ServletRequest request, ServletResponse response) {
        throw new IllegalStateException("Test Bench previews run synchronously.");
    }
}
