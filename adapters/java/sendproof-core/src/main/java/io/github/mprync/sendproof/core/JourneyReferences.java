package io.github.mprync.sendproof.core;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/** Checks references that depend on the served OpenAPI or the workflow's execution order. */
final class JourneyReferences {
    private static final Set<String> HTTP_METHODS = Set.of("get", "put", "post", "delete", "options", "head", "patch", "trace", "query");
    private static final Pattern REFERENCE = Pattern.compile("(?:^|\\{)(\\$(?:inputs|steps)(?=\\.|[}\\s]|$)[^}\\s]*)");

    private JourneyReferences() {}

    static Set<String> operations(JsonNode openApi) {
        if (openApi == null || !openApi.path("paths").isObject()) {
            throw new IllegalArgumentException("Expected an OpenAPI document with a paths object");
        }
        var ids = new HashSet<String>();
        for (JsonNode path : openApi.path("paths")) {
            for (String method : HTTP_METHODS) {
                JsonNode id = path.path(method).path("operationId");
                if (id.isTextual() && !id.textValue().isBlank()) {
                    ids.add(id.textValue());
                }
            }
        }
        return ids;
    }

    static List<String> validate(JsonNode workflow, JsonNode sidecar, Set<String> operations) {
        List<String> errors = new ArrayList<>();
        JsonNode inputs = workflow.path("inputs").path("properties");
        JsonNode steps = workflow.path("steps");
        JsonNode expected = sidecar.path("journeys").path(workflow.path("workflowId").asText()).path("steps");
        Map<String, JsonNode> outputs = new LinkedHashMap<>();
        if (steps.isEmpty()) {
            errors.add("At least one step is required");
        }
        for (JsonNode step : steps) {
            String id = step.path("stepId").asText();
            String operation = step.path("operationId").asText("");
            if (!operations.contains(operation)) {
                errors.add("Step " + id + ": unknown OpenAPI operationId " + operation);
            }
            if (outputs.containsKey(id)) {
                errors.add("Duplicate step ID " + id);
            }
            for (JsonNode parameter : step.path("parameters")) {
                check(parameter.path("value"), id, inputs, outputs, errors);
            }
            check(step.path("requestBody").path("payload"), id, inputs, outputs, errors);
            check(step.path("outputs"), id, inputs, outputs, errors);
            // Write expectations are evaluated after this step has extracted its outputs.
            outputs.put(id, step.path("outputs"));
            check(expected.path(id), id, inputs, outputs, errors);
        }
        return errors;
    }

    private static void check(JsonNode node, String stepId, JsonNode inputs, Map<String, JsonNode> outputs, List<String> errors) {
        if (node.isContainerNode()) {
            node.forEach(value -> check(value, stepId, inputs, outputs, errors));
        } else if (node.isTextual()) {
            var references = REFERENCE.matcher(node.textValue());
            while (references.find()) {
                String reference = references.group(1);
                String[] parts = reference.split("\\.", -1);
                if (parts[0].equals("$inputs")) {
                    if (parts.length < 2 || !inputs.has(parts[1]) || reference.endsWith(".")) {
                        errors.add("Step " + stepId + ": unknown input reference " + reference);
                    }
                } else if (parts.length < 4 || !"outputs".equals(parts[2])
                        || !outputs.containsKey(parts[1]) || !outputs.get(parts[1]).has(parts[3]) || reference.endsWith(".")) {
                    errors.add("Step " + stepId + ": invalid step output reference " + reference);
                }
            }
        }
    }
}
