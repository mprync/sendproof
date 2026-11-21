package io.github.mprync.sendproof.spring;

import io.github.mprync.sendproof.core.Capabilities.Identity;
import jakarta.servlet.http.HttpServletRequest;

/** The identity from the servlet principal, used when Spring Security is not present. It reports no role. */
final class PrincipalIdentityResolver implements WorkbenchIdentityResolver {

    @Override
    public Identity resolve(HttpServletRequest request) {
        var principal = request.getUserPrincipal();
        return principal == null ? null : new Identity(principal.getName(), null);
    }
}
