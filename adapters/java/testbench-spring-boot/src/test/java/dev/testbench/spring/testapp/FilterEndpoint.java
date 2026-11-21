package dev.testbench.spring.testapp;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.concurrent.atomic.AtomicInteger;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Answers {@code POST /filter-endpoint} from a servlet filter, the way Spring Security's logout or login endpoints do,
 * and counts each time it acts. It stands in for side effects that happen before any controller is chosen.
 */
@Component
public class FilterEndpoint extends OncePerRequestFilter {
    public static final AtomicInteger HITS = new AtomicInteger();

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String path = request.getRequestURI().substring(request.getContextPath().length());
        if (path.equals("/filter-endpoint")) {
            HITS.incrementAndGet();
            response.setStatus(204);
            return;
        }
        chain.doFilter(request, response);
    }
}
