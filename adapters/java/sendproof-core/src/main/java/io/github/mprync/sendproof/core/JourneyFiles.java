package io.github.mprync.sendproof.core;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Fixed pairs of registered JSON documents. Request paths never resolve resources or files directly. */
public final class JourneyFiles {
    private static final String ARAZZO = ".arazzo.json";
    private static final String EXPECT = ".expect.json";
    private static final String ROUTE = "journeys/";
    private final Map<String, Pair> pairs = new LinkedHashMap<>();

    public JourneyFiles snapshot() {
        var copy = new JourneyFiles();
        copy.pairs.putAll(pairs);
        return copy;
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
        if (!filename.matches("[A-Za-z0-9._~-]+" + java.util.regex.Pattern.quote(ARAZZO))) {
            throw new IllegalArgumentException("A journey needs a URL-safe .arazzo.json filename: " + filename);
        }
        String stem = filename.substring(0, filename.length() - ARAZZO.length());
        if (pairs.containsKey(stem)) {
            throw new IllegalArgumentException("Duplicate journey filename: " + filename);
        }
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
            pairs.put(stem, new Pair(title.isBlank() ? stem : title, document, expected));
        } catch (IOException error) {
            throw new IllegalArgumentException("Could not register journey " + filename, error);
        }
    }

    public List<Capabilities.Journey> discover(String mount) {
        String root = mount + "/sendproof/" + ROUTE;
        return pairs.entrySet().stream().map(entry -> new Capabilities.Journey(entry.getValue().name, "file",
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

    private record Pair(String name, JsonNode arazzo, JsonNode expectations) {
    }

    @FunctionalInterface
    private interface OpenFile {
        InputStream read(String location) throws IOException;
    }
}
