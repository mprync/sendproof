package dev.testbench.spring;

import dev.testbench.core.Capabilities.Identity;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.security.authentication.AnonymousAuthenticationToken;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;

/** The identity from Spring Security: the authentication name and the first {@code ROLE_} authority. */
final class SecurityIdentityResolver implements WorkbenchIdentityResolver {

    @Override
    public Identity resolve(HttpServletRequest request) {
        Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
        if (authentication == null || !authentication.isAuthenticated()
                || authentication instanceof AnonymousAuthenticationToken) {
            return null;
        }
        String role = null;
        for (GrantedAuthority authority : authentication.getAuthorities()) {
            String name = authority.getAuthority();
            if (name != null && name.startsWith("ROLE_")) {
                role = name.substring("ROLE_".length());
                break;
            }
        }
        return new Identity(authentication.getName(), role);
    }
}
