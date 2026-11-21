package io.github.mprync.sendproof.spring;

import io.github.mprync.sendproof.core.Capabilities.OpenApiDocument;
import java.util.List;

/**
 * The OpenAPI documents the workbench offers. URLs are relative to the context path. The default implementation reads
 * {@code sendproof.*} properties; with springdoc on the classpath the documents are discovered from it.
 */
public interface OpenApiDocuments {

    /** Returns the primary document URL. */
    String primaryUrl();

    /** Returns every document, including groups. */
    List<OpenApiDocument> documents();
}
