package dev.testbench.spring;

import jakarta.servlet.http.HttpServletRequest;

/**
 * Optional extra gate for the workbench, evaluated after the host's own security. It applies to the workbench pages
 * and API and to every preview and observed send. Return {@code false} to answer 403.
 *
 * <p>With Spring Security, protect {@code /bench/**} in the {@code SecurityFilterChain} for the pages and use this
 * hook (for example "has role developer") for previews, whose rewritten requests no longer match {@code /bench/**}.
 */
@FunctionalInterface
public interface WorkbenchAccess {

    /** Returns whether the authenticated caller may use the workbench. */
    boolean permits(HttpServletRequest request);

    /** An access policy that admits everyone the host's security already admitted. */
    WorkbenchAccess PERMIT_ALL = request -> true;
}
