package io.github.mprync.sendproof.spring;

import io.github.mprync.sendproof.core.Capabilities.PreviewOperation;
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

    PreviewOperations(ObjectProvider<RequestMappingHandlerMapping> mappings) {
        this.mappings = mappings;
    }

    Set<PreviewOperation> list() {
        Set<PreviewOperation> operations = new TreeSet<>(
                Comparator.comparing(PreviewOperation::path).thenComparing(PreviewOperation::method));
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
