package io.github.mprync.sendproof.spring;

import io.github.mprync.sendproof.core.Capabilities.PreviewOperation;
import io.github.mprync.sendproof.core.Capabilities.PreviewUnavailable;
import io.github.mprync.sendproof.core.stores.StoreGuard;
import java.util.ArrayList;
import java.util.List;
import java.util.Comparator;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Pattern;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.servlet.mvc.method.RequestMappingInfo;
import org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerMapping;

/** Lists the operations marked with {@link SendproofPreview} as OpenAPI path templates and verbs. */
final class PreviewOperations {
    private static final Pattern REGEX_VARIABLE = Pattern.compile("\\{([^}:*]+)(?::[^}]*)?}");
    private static final Pattern CATCH_ALL_VARIABLE = Pattern.compile("\\{\\*([^}]+)}");

    private final ObjectProvider<RequestMappingHandlerMapping> mappings;
    private final UnguardedClients unguarded;

    PreviewOperations(ObjectProvider<RequestMappingHandlerMapping> mappings, UnguardedClients unguarded) {
        this.mappings = mappings;
        this.unguarded = unguarded;
    }

    private UnguardedClients.Block block() {
        return unguarded == null ? null : unguarded.block();
    }

    /**
     * Lists the operations marked {@code @SendproofPreview(enabled = false)} with the reason the workbench shows. They are
     * absent from {@link #list()}. While the application has a client bean Sendproof can't guard, every marked operation is
     * listed here too, with that reason.
     *
     * @throws IllegalStateException when a mark gives neither a reason nor the stores it writes
     */
    List<PreviewUnavailable> unavailable() {
        var found = new java.util.TreeMap<String, PreviewUnavailable>();
        UnguardedClients.Block block = block();
        for (RequestMappingHandlerMapping mapping : mappings) {
            for (var entry : mapping.getHandlerMethods().entrySet()) {
                HandlerMethod method = entry.getValue();
                String reason;
                List<String> stores;
                if (PreviewEligibility.isUnavailable(method)) {
                    SendproofPreview mark = PreviewEligibility.mark(method);
                    reason = mark.reason().isBlank()
                            ? (mark.stores().length > 0 ? StoreGuard.writeReason(mark.stores()[0]) : null) : mark.reason();
                    if (reason == null || reason.length() > 512) {
                        throw new IllegalStateException("@SendproofPreview(enabled = false) on " + method.getShortLogMessage()
                                + " needs a reason (at most 512 characters), or the stores it writes.");
                    }
                    stores = List.of(mark.stores());
                } else if (block != null && PreviewEligibility.isMarked(method)) {
                    reason = block.reason();
                    stores = block.stores();
                } else {
                    continue;
                }
                RequestMappingInfo info = entry.getKey();
                Set<String> patterns = info.getPathPatternsCondition() != null
                        ? info.getPathPatternsCondition().getPatternValues()
                        : info.getPatternsCondition() == null ? Set.of() : info.getPatternsCondition().getPatterns();
                for (RequestMethod verb : info.getMethodsCondition().getMethods()) {
                    if (verb == RequestMethod.HEAD || verb == RequestMethod.OPTIONS || verb == RequestMethod.TRACE) {
                        continue;
                    }
                    for (String pattern : patterns) {
                        String path = openApiPath(pattern);
                        found.put(path + " " + verb.name(), new PreviewUnavailable(verb.name(), path, reason, stores));
                    }
                }
            }
        }
        return new ArrayList<>(found.values());
    }

    Set<PreviewOperation> list() {
        Set<PreviewOperation> operations = new TreeSet<>(
                Comparator.comparing(PreviewOperation::path).thenComparing(PreviewOperation::method));
        if (block() != null) {
            // Every marked operation is listed as unavailable instead.
            return operations;
        }
        for (RequestMappingHandlerMapping mapping : mappings) {
            for (var entry : mapping.getHandlerMethods().entrySet()) {
                HandlerMethod method = entry.getValue();
                if (!PreviewEligibility.isMarked(method)) {
                    continue;
                }
                RequestMappingInfo info = entry.getKey();
                Set<String> patterns = info.getPathPatternsCondition() != null
                        ? info.getPathPatternsCondition().getPatternValues()
                        : info.getPatternsCondition() == null ? Set.of() : info.getPatternsCondition().getPatterns();
                for (RequestMethod verb : info.getMethodsCondition().getMethods()) {
                    // A mapping with no explicit verb is not advertised: eligibility must be deliberate.
                    if (verb == RequestMethod.HEAD || verb == RequestMethod.OPTIONS || verb == RequestMethod.TRACE) {
                        continue;
                    }
                    for (String pattern : patterns) {
                        operations.add(new PreviewOperation(verb.name(), openApiPath(pattern)));
                    }
                }
            }
        }
        return operations;
    }

    /** Converts {@code /items/{id:\d+}} and {@code /files/{*rest}} to OpenAPI's {@code /items/{id}}. */
    static String openApiPath(String pattern) {
        String path = CATCH_ALL_VARIABLE.matcher(pattern).replaceAll("{$1}");
        return REGEX_VARIABLE.matcher(path).replaceAll("{$1}");
    }
}
