package io.github.mprync.sendproof.core;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Supplier;
import org.slf4j.LoggerFactory;

/** Pairs of registered file or generated documents. Request paths never resolve resources or files directly. */
public final class JourneyFiles {
    private static final String ARAZZO = ".arazzo.json";
    private static final String EXPECT = ".expect.json";
    private static final String ROUTE = "journeys/";
    private final Map<String, Journey.Prepared> code = new LinkedHashMap<>();
    private volatile Map<String, Pair> pairs = new LinkedHashMap<>();

    public JourneyFiles snapshot() {
        var copy = new JourneyFiles();
        copy.pairs.putAll(pairs);
        copy.code.putAll(code);
        return copy;
    }

    public void register(Journey journey) {
        var definition = journey.prepare();
        String stem = definition.stem();
        checkAvailable(stem);
        code.put(stem, definition);
    }

    /** Generates and publishes the valid code journeys against the primary OpenAPI document. */
    public void startCode(String openApiUrl, Supplier<JsonNode> openApi, boolean development) {
        if (code.isEmpty()) {
            return;
        }
        List<String> problems = new ArrayList<>();
        var published = new LinkedHashMap<>(pairs);
        code.keySet().forEach(published::remove);
        try {
            LocalUrl.validate(openApiUrl);
            var operations = JourneyReferences.operations(openApi.get());
            var workflows = new HashSet<String>();
            published.values().forEach(pair -> pair.arazzo.path("workflows")
                    .forEach(workflow -> workflows.add(workflow.path("workflowId").asText())));
            for (var definition : code.values()) {
                ObjectNode arazzo = definition.arazzo().deepCopy();
                ObjectNode workflow = (ObjectNode) arazzo.path("workflows").get(0);
                String id = workflow.path("workflowId").asText();
                var errors = JourneyReferences.validate(workflow, definition.expectations(), operations);
                if (workflows.contains(id)) {
                    errors.add("Duplicate workflow ID " + id);
                }
                if (!errors.isEmpty()) {
                    errors.forEach(error -> problems.add(id + ": " + error));
                    continue;
                }
                workflows.add(id);
                ((ObjectNode) arazzo.path("sourceDescriptions").get(0)).put("url", openApiUrl);
                published.put(definition.stem(), new Pair(definition.name(), "code", arazzo, definition.expectations()));
            }
        } catch (RuntimeException error) {
            problems.add("Cannot load OpenAPI " + openApiUrl + " for code journeys: " + error.getMessage());
        }
        if (!problems.isEmpty()) {
            var message = "Invalid Sendproof journeys:\n - " + String.join("\n - ", problems);
            if (development) {
                throw new IllegalStateException(message);
            }
            LoggerFactory.getLogger(JourneyFiles.class).warn(message);
        }
        pairs = published;
    }

    public void register(Path arazzo) {
        register(arazzo.toString(), location -> Files.newInputStream(Path.of(location)));
    }

    public void registerResource(String arazzo, ClassLoader loader) {
        register(arazzo, location -> {
            InputStream resource = loader.getResourceAsStream(location);
            if (resource == null) {
                throw new IOException("No such classpath resource: " + location);
            }
            return resource;
        });
    }

    private void register(String location, OpenFile open) {
        String filename = Path.of(location).getFileName().toString();
        if (!filename.endsWith(ARAZZO)) {
            throw new IllegalArgumentException("A journey needs a URL-safe .arazzo.json filename: " + filename);
        }
        String stem = requireStem(filename.substring(0, filename.length() - ARAZZO.length()));
        checkAvailable(stem);
        String expectations = location.substring(0, location.length() - ARAZZO.length()) + EXPECT;
        try (var source = open.read(location); var sidecar = open.read(expectations)) {
            JsonNode document = Json.MAPPER.readTree(source);
            JsonNode expected = Json.MAPPER.readTree(sidecar);
            if (document == null || expected == null || !"1.1.0".equals(document.path("arazzo").asText())
                    || !"1.0".equals(expected.path("sendproofExpectations").asText())
                    || !filename.equals(expected.path("arazzo").asText()) || !expected.path("journeys").isObject()) {
                throw new IllegalArgumentException("Expected a paired Arazzo 1.1.0 and Sendproof expectations 1.0 document.");
            }
            var title = document.path("info").path("title").asText(stem);
            pairs.put(stem, new Pair(title.isBlank() ? stem : title, "file", document, expected));
        } catch (IOException error) {
            throw new IllegalArgumentException("Could not register journey " + filename, error);
        }
    }

    static String requireStem(String stem) {
        if (stem == null || !stem.matches("[A-Za-z0-9._~-]+")) {
            throw new IllegalArgumentException("A journey needs a URL-safe document stem: " + stem);
        }
        return stem;
    }

    private void checkAvailable(String stem) {
        if (pairs.containsKey(stem) || code.containsKey(stem)) {
            throw new IllegalArgumentException("Duplicate journey filename: " + stem + ARAZZO);
        }
    }

    public List<Capabilities.Journey> discover(String mount) {
        String root = mount + "/sendproof/" + ROUTE;
        return pairs.entrySet().stream().map(entry -> new Capabilities.Journey(entry.getValue().name, entry.getValue().source,
                root + entry.getKey() + ARAZZO, root + entry.getKey() + EXPECT)).toList();
    }

    public static boolean matches(String path) {
        return path.startsWith(ROUTE) && path.indexOf('/', ROUTE.length()) < 0
                && (path.endsWith(ARAZZO) || path.endsWith(EXPECT));
    }

    /** Returns null for an unregistered journey route. Rebase the local sources in a copy for each mount. */
    public JsonNode find(String path, String mount) {
        if (!matches(path)) {
            return null;
        }
        boolean ar = path.endsWith(ARAZZO);
        var pair = pairs.get(path.substring(ROUTE.length(), path.length() - (ar ? ARAZZO : EXPECT).length()));
        if (pair == null) {
            return null;
        }
        if (!ar) {
            return pair.expectations.deepCopy();
        }
        JsonNode served = pair.arazzo.deepCopy();
        if (!mount.isEmpty()) {
            for (JsonNode source : served.path("sourceDescriptions")) {
                if (source instanceof ObjectNode object && source.path("url").isTextual()
                        && LocalUrl.isLocal(source.path("url").textValue())) {
                    object.put("url", mount + source.path("url").textValue());
                }
            }
        }
        return served;
    }

    private record Pair(String name, String source, JsonNode arazzo, JsonNode expectations) {
    }

    @FunctionalInterface
    private interface OpenFile {
        InputStream read(String location) throws IOException;
    }
}
