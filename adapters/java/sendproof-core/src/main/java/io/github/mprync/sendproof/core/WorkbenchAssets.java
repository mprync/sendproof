package io.github.mprync.sendproof.core;

import com.fasterxml.jackson.databind.JsonNode;
import java.io.IOException;
import java.io.InputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

/**
 * The embedded workbench UI. The files come from the shared UI bundle (packed by {@code tools/pack-ui.mjs}) and are
 * only served when listed in the bundle's {@code manifest.json}, with their recorded content type. Bytes are verified
 * against the manifest's SHA-256 the first time each file is read.
 */
public final class WorkbenchAssets {
    /** The classpath directory that holds the bundle. */
    public static final String ROOT = "sendproof-ui/";

    /** A verified asset. */
    public record Asset(String path, String contentType, byte[] bytes, String sha256) {
        /** Returns a strong ETag for conditional requests. */
        public String etag() {
            return '"' + sha256 + '"';
        }
    }

    private record Entry(String contentType, String sha256, long bytes) {
    }

    private final ClassLoader loader;
    private final Map<String, Entry> manifest;
    private final Map<String, Asset> verified = new ConcurrentHashMap<>();
    private final String bundleHash;

    /** Loads the bundle manifest from the given class loader. */
    public WorkbenchAssets(ClassLoader loader) {
        this.loader = loader;
        var entries = new java.util.LinkedHashMap<String, Entry>();
        String hash = "";
        try (InputStream stream = loader.getResourceAsStream(ROOT + "manifest.json")) {
            if (stream == null) {
                throw new IllegalStateException("The Sendproof UI bundle is missing from the classpath (" + ROOT
                        + "manifest.json). Add the sendproof-ui artifact.");
            }
            JsonNode root = Json.MAPPER.readTree(stream);
            hash = root.path("bundleHash").asText("");
            root.path("files").fields().forEachRemaining(file -> entries.put(file.getKey(),
                    new Entry(file.getValue().path("contentType").asText(), file.getValue().path("sha256").asText(),
                            file.getValue().path("bytes").asLong())));
        } catch (IOException error) {
            throw new IllegalStateException("The Sendproof UI manifest cannot be read.", error);
        }
        this.manifest = Map.copyOf(entries);
        this.bundleHash = hash;
    }

    /** Returns the bundle hash from the manifest. */
    public String bundleHash() {
        return bundleHash;
    }

    /** Returns whether the bundle contains the given relative path. */
    public boolean contains(String path) {
        return manifest.containsKey(path);
    }

    /**
     * Finds a listed asset by its relative path (for example {@code index.html}).
     *
     * @throws IllegalStateException when the packaged bytes do not match the manifest
     */
    public Optional<Asset> find(String path) {
        Entry entry = manifest.get(path);
        if (entry == null) {
            return Optional.empty();
        }
        return Optional.of(verified.computeIfAbsent(path, key -> load(key, entry)));
    }

    private Asset load(String path, Entry entry) {
        try (InputStream stream = loader.getResourceAsStream(ROOT + path)) {
            if (stream == null) {
                throw new IllegalStateException("The UI bundle lists " + path + " but it is missing.");
            }
            byte[] bytes = stream.readAllBytes();
            String actual = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
            if (!actual.equalsIgnoreCase(entry.sha256()) || bytes.length != entry.bytes()) {
                throw new IllegalStateException("The UI bundle file " + path + " does not match its manifest.");
            }
            return new Asset(path, entry.contentType(), bytes, entry.sha256());
        } catch (IOException | NoSuchAlgorithmException error) {
            throw new IllegalStateException("The UI bundle file " + path + " cannot be read.", error);
        }
    }
}
