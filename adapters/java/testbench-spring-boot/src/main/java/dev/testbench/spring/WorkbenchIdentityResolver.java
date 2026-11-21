package dev.testbench.spring;

import dev.testbench.core.Capabilities.Identity;
import jakarta.servlet.http.HttpServletRequest;

/** Resolves the identity shown in the workbench for the current request. Register a bean to customize it. */
@FunctionalInterface
public interface WorkbenchIdentityResolver {

    /** Returns the authenticated identity, or {@code null} for an anonymous caller. */
    Identity resolve(HttpServletRequest request);
}
