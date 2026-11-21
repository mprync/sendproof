package io.github.mprync.sendproof.fixture;

import io.github.mprync.sendproof.core.Capabilities.Identity;
import io.github.mprync.sendproof.spring.WorkbenchIdentityResolver;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.List;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.AnonymousAuthenticationFilter;
import org.springframework.security.web.authentication.HttpStatusEntryPoint;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Real Spring Security rules for the fixture: stateless, cookie-token authentication, 401 for anonymous callers, 403
 * for a viewer's writes. The workbench pages and discovery are public; trace ownership is enforced by Sendproof.
 */
@Configuration
public class SecurityConfig {

    @Bean
    SecurityFilterChain fixtureSecurity(HttpSecurity http, FixtureUsers users) throws Exception {
        http.csrf(AbstractHttpConfigurer::disable)
                .sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .exceptionHandling(errors -> errors
                        .authenticationEntryPoint(new HttpStatusEntryPoint(HttpStatus.UNAUTHORIZED))
                        .accessDeniedHandler((request, response, denied) -> response.setStatus(HttpStatus.FORBIDDEN.value())))
                .addFilterBefore(new CookieSessionFilter(users), AnonymousAuthenticationFilter.class)
                .authorizeHttpRequests(rules -> rules
                        .requestMatchers("/ready", "/sendproof/**", "/auth/sign-in", "/v3/api-docs/**").permitAll()
                        .requestMatchers("/auth/personas/**").authenticated()
                        .requestMatchers(HttpMethod.GET, "/items/**").hasAnyRole("admin", "viewer")
                        .anyRequest().hasRole("admin"));
        return http.build();
    }

    /** Shows "Fixture Admin" and the role in the workbench instead of the account's e-mail address. */
    @Bean
    WorkbenchIdentityResolver fixtureIdentity(FixtureUsers users) {
        return request -> {
            var authentication = SecurityContextHolder.getContext().getAuthentication();
            if (authentication == null || !authentication.isAuthenticated()) {
                return null;
            }
            return users.byEmail(authentication.getName())
                    .map(account -> new Identity(account.name(), account.role())).orElse(null);
        };
    }

    /** Authenticates a request from the fixture's session cookie. */
    private static final class CookieSessionFilter extends OncePerRequestFilter {
        private final FixtureUsers users;

        CookieSessionFilter(FixtureUsers users) {
            this.users = users;
        }

        @Override
        protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
                throws ServletException, IOException {
            Cookie[] cookies = request.getCookies();
            if (cookies != null) {
                for (Cookie cookie : cookies) {
                    if (cookie.getName().equals(AuthController.COOKIE)) {
                        users.session(cookie.getValue()).ifPresent(account ->
                                SecurityContextHolder.getContext().setAuthentication(
                                        UsernamePasswordAuthenticationToken.authenticated(account.email(), null,
                                                List.of(new SimpleGrantedAuthority("ROLE_" + account.role())))));
                    }
                }
            }
            chain.doFilter(request, response);
        }
    }
}
