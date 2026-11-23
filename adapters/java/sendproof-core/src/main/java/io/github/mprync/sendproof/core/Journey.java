package io.github.mprync.sendproof.core;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.github.victools.jsonschema.generator.Option;
import com.github.victools.jsonschema.generator.OptionPreset;
import com.github.victools.jsonschema.generator.SchemaGenerator;
import com.github.victools.jsonschema.generator.SchemaGeneratorConfigBuilder;
import com.github.victools.jsonschema.generator.SchemaVersion;
import com.github.victools.jsonschema.module.jackson.JacksonModule;
import com.github.victools.jsonschema.module.jackson.JacksonOption;
import java.time.LocalDate;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.function.Consumer;

/** A code-defined Arazzo workflow, registered with the adapter's journey builder. */
public final class Journey {
    private final String id;
    private final ObjectNode workflow = Json.MAPPER.createObjectNode();
    private final ObjectNode expectation = Json.MAPPER.createObjectNode();
    private final ObjectNode expectedSteps = Json.MAPPER.createObjectNode();
    private final ObjectNode approvals = Json.MAPPER.createObjectNode();
    private String stem;
    private String name;
    private String source = "api";

    private Journey(String id) {
        this.id = requireId("Workflow", id);
        this.stem = id;
        this.name = id;
        workflow.put("workflowId", id).putArray("steps");
    }

    public static Journey define(String workflowId) {
        return new Journey(workflowId);
    }

    /** Sets the URL-safe document stem shared by both generated documents. */
    public Journey document(String filenameStem) {
        stem = JourneyFiles.requireStem(filenameStem);
        return this;
    }

    /** Sets the discovery name and the workflow's summary unless one is provided. */
    public Journey name(String name) {
        this.name = requireText("Journey name", name);
        return this;
    }

    public Journey source(String name) {
        source = requireId("Source", name);
        return this;
    }

    public Journey summary(String summary) {
        workflow.put("summary", summary);
        return this;
    }

    public Journey group(String group) {
        expectation.put("group", group);
        return this;
    }

    public Journey runAs(String email) {
        expectation.put("runAs", email);
        return this;
    }

    public Journey sendOnly(String reason) {
        expectation.put("sendOnly", true).put("sendOnlyReason", requireText("Send-only reason", reason));
        return this;
    }

    public Journey definedIn(Class<?> type) {
        expectation.putObject("definedIn").put("type", type.getSimpleName());
        return this;
    }

    /** Derives JSON Schema 2020-12 from the fields and Jackson annotations of a Java or Kotlin class. */
    public Journey inputs(Class<?> type) {
        var config = new SchemaGeneratorConfigBuilder(Json.MAPPER, SchemaVersion.DRAFT_2020_12, OptionPreset.PLAIN_JSON)
                .without(Option.SCHEMA_VERSION_INDICATOR)
                .with(new JacksonModule(JacksonOption.RESPECT_JSONPROPERTY_REQUIRED));
        return inputs(new SchemaGenerator(config.build()).generateSchema(type));
    }

    /** Uses an explicit object schema with the named inputs declared in its top-level properties. */
    public Journey inputs(ObjectNode schema) {
        workflow.set("inputs", schema.deepCopy());
        return this;
    }

    public Journey defaultInput(String name, Object value) {
        if (!(workflow.path("inputs").path("properties").path(name) instanceof ObjectNode property)) {
            throw new IllegalArgumentException("Journey " + id + " has no input property " + name);
        }
        property.set("default", Json.MAPPER.valueToTree(value));
        return this;
    }

    public Journey step(String stepId, String operationId, Consumer<Step> configure) {
        var step = new Step(requireId("Step", stepId), operationId);
        configure.accept(step);
        workflow.withArray("steps").add(step.arazzo);
        if (!step.expectation.isEmpty()) {
            expectedSteps.set(stepId, step.expectation);
        }
        if (step.writesRedis && !expectation.has("sendOnly")) {
            sendOnly("Step " + stepId + " writes to Redis, which can't roll back.");
        }
        return this;
    }

    public static String inputRef(String name) {
        return "$inputs." + name;
    }

    public static String outputRef(String stepId, String outputName) {
        return "$steps." + stepId + ".outputs." + outputName;
    }

    Prepared prepare() {
        var arazzo = Json.MAPPER.createObjectNode().put("arazzo", "1.1.0");
        arazzo.putObject("info").put("title", name).put("version", "1.0.0");
        arazzo.putArray("sourceDescriptions").addObject().put("name", source).put("type", "openapi");
        var describedWorkflow = workflow.deepCopy();
        if (!describedWorkflow.has("summary")) {
            describedWorkflow.put("summary", name);
        }
        arazzo.putArray("workflows").add(describedWorkflow);
        var sidecar = Json.MAPPER.createObjectNode().put("sendproofExpectations", "1.0").put("arazzo", stem + ".arazzo.json");
        var entry = expectation.deepCopy();
        entry.set("steps", expectedSteps.deepCopy());
        sidecar.putObject("journeys").set(id, entry);
        var records = sidecar.putArray("approvedDifferences");
        approvals.forEach(record -> records.add(record.deepCopy()));
        return new Prepared(stem, name, arazzo, sidecar);
    }

    private static String requireId(String kind, String id) {
        if (id == null || !id.matches("[A-Za-z0-9_-]+")) {
            throw new IllegalArgumentException(kind + " needs an ID containing only letters, digits, hyphens or underscores: " + id);
        }
        return id;
    }

    record Prepared(String stem, String name, ObjectNode arazzo, ObjectNode expectations) {}

    public enum In {
        PATH, QUERY, HEADER, COOKIE
    }

    public final class Step {
        private final String id;
        private final ObjectNode arazzo;
        private final ObjectNode expectation = Json.MAPPER.createObjectNode();
        private boolean writesRedis;

        private Step(String id, String operationId) {
            this.id = id;
            arazzo = Json.MAPPER.createObjectNode().put("stepId", id).put("operationId", operationId);
        }

        public Step parameter(In location, String name, Object value) {
            arazzo.withArray("parameters").addObject().put("name", name)
                    .put("in", location.name().toLowerCase(Locale.ROOT))
                    .set("value", Json.MAPPER.valueToTree(value));
            return this;
        }

        /** Sets a JSON request payload. Maps and lists can contain runtime references alongside literals. */
        public Step body(Object payload) {
            arazzo.putObject("requestBody").put("contentType", "application/json")
                    .set("payload", Json.MAPPER.valueToTree(payload));
            return this;
        }

        public Step output(String name, String expression) {
            var outputs = arazzo.withObjectProperty("outputs");
            if (outputs.has(name)) {
                throw new IllegalArgumentException("Step " + id + " already defines output " + name);
            }
            outputs.put(name, expression);
            return this;
        }

        /** Reads the JSON response at a JSON Pointer such as {@code /id}. */
        public Step outputFromBody(String name, String pointer) {
            return output(name, "$response.body#" + pointer);
        }

        public Step succeedsWith(int status) {
            return successCriteria("$statusCode == " + status);
        }

        public Step successCriteria(String condition) {
            arazzo.withArray("successCriteria").addObject().put("condition", condition);
            return this;
        }

        public Step runAs(String email) {
            expectation.put("persona", email);
            return this;
        }

        public Step expectWrites(Consumer<StepWrites> configure) {
            var writes = new StepWrites();
            configure.accept(writes);
            if (writes.expectsNothing && (!writes.writes.isEmpty() || !writes.effects.isEmpty())) {
                throw new IllegalStateException("A step that expects writes or effects cannot also expect nothing");
            }
            expectation.set("writes", writes.writes);
            if (!writes.effects.isEmpty() || writes.expectsNothing) {
                expectation.set("effects", writes.effects);
            } else {
                expectation.remove("effects");
            }
            expectation.put("unlisted", "fail");
            writesRedis = writes.writesRedis;
            return this;
        }

        /** Adds an approved value difference for one expected field in this step. */
        public Step approvedDifference(ApprovedDifference difference) {
            var approvalId = requireText("Approved difference ID", difference.id());
            if (approvals.has(approvalId)) {
                throw new IllegalArgumentException("Approved difference " + approvalId + " already covers an expectation");
            }
            var record = approvals.putObject(approvalId).put("id", approvalId).put("journey", Journey.this.id)
                    .put("step", id).put("kind", "value");
            record.set("target", Json.MAPPER.valueToTree(difference.target()));
            record.set("expected", Json.MAPPER.valueToTree(difference.expected()));
            record.set("actual", Json.MAPPER.valueToTree(difference.actual()));
            record.put("reason", requireText("Approval reason", difference.reason()))
                    .put("approvedBy", requireText("Approver", difference.approvedBy()))
                    .put("approvedOn", Objects.requireNonNull(difference.approvedOn(), "Approval date").toString());
            if (difference.expires() != null) {
                record.put("expires", difference.expires().toString());
            }
            if (difference.link() != null) {
                record.put("link", difference.link());
            }
            return this;
        }
    }

    /** The target names a store and a SQL table, MongoDB collection, or Redis key, together with the field. */
    public record ApprovedDifference(String id, Map<String, String> target, Object expected, Object actual,
                                     String reason, String approvedBy, LocalDate approvedOn, LocalDate expires, String link) {}

    private static String requireText(String label, String text) {
        if (text == null || text.isBlank()) {
            throw new IllegalArgumentException(label + " is required");
        }
        return text;
    }
}
