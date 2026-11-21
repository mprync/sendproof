package io.github.mprync.sendproof.spring;

import io.github.mprync.sendproof.core.PreviewProvider;
import io.github.mprync.sendproof.core.TraceStore;
import io.github.mprync.sendproof.core.WorkbenchAssets;
import org.springdoc.core.models.GroupedOpenApi;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.boot.autoconfigure.web.servlet.WebMvcAutoConfiguration;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Conditional;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.Ordered;
import org.springframework.core.env.Environment;
import org.springframework.web.servlet.DispatcherServlet;
import org.springframework.web.servlet.HandlerMapping;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;
import org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerMapping;

/**
 * Registers the workbench, the preview filter and the handler interceptor. Nothing is registered unless
 * {@code sendproof.enabled=true} (see {@link SendproofEnabledCondition}).
 */
@AutoConfiguration(after = WebMvcAutoConfiguration.class)
@ConditionalOnWebApplication(type = ConditionalOnWebApplication.Type.SERVLET)
@ConditionalOnClass(DispatcherServlet.class)
@Conditional(SendproofEnabledCondition.class)
@EnableConfigurationProperties(SendproofProperties.class)
public class SendproofAutoConfiguration {
    /** Spring Boot's default order for the Spring Security filter chain ({@code spring.security.filter.order}). */
    private static final int SECURITY_FILTER_ORDER = -100;

    /** Property values with the optional {@link Sendproof} builder merged over them. */
    @Bean
    SendproofSettings sendproofSettings(SendproofProperties properties, ObjectProvider<Sendproof> builder) {
        return SendproofSettings.resolve(properties, builder.getIfAvailable());
    }

    @Bean
    @ConditionalOnMissingBean
    TraceStore sendproofTraceStore(SendproofSettings settings) {
        return new TraceStore(settings.traceRetention(), System::nanoTime);
    }

    @Bean
    @ConditionalOnMissingBean
    WorkbenchAccess sendproofWorkbenchAccess(ObjectProvider<Sendproof> builder) {
        Sendproof configured = builder.getIfAvailable();
        return configured != null && configured.access() != null ? configured.access() : WorkbenchAccess.PERMIT_ALL;
    }

    @Bean
    @ConditionalOnMissingBean
    TraceOwnerResolver sendproofTraceOwnerResolver(ObjectProvider<Sendproof> builder) {
        Sendproof configured = builder.getIfAvailable();
        return configured != null && configured.traceOwner() != null ? configured.traceOwner()
                : TraceOwnerResolver.principal();
    }

    @Bean
    @ConditionalOnMissingBean
    WorkbenchAssets sendproofWorkbenchAssets() {
        return new WorkbenchAssets(SendproofAutoConfiguration.class.getClassLoader());
    }

    @Bean
    PreviewProviders sendproofPreviewProviders(ObjectProvider<PreviewProvider> providers) {
        return new PreviewProviders(providers);
    }

    @Bean
    PreviewOperations sendproofPreviewOperations(ObjectProvider<RequestMappingHandlerMapping> mappings) {
        return new PreviewOperations(mappings);
    }

    @Bean
    @ConditionalOnMissingBean(OpenApiDocuments.class)
    OpenApiDocuments sendproofOpenApiDocuments(SendproofSettings settings) {
        return new PropertyOpenApiDocuments(settings, "/v3/api-docs");
    }

    @Bean
    FilterRegistrationBean<SendproofFilter> sendproofFilter(SendproofSettings settings, Environment environment,
                                                            ObjectProvider<HandlerMapping> handlerMappings) {
        // The preview must be rewritten before Spring Security sees it; otherwise the security rules would be matched
        // against /sendproof/_preview/... instead of the real operation's path.
        int securityOrder = environment.getProperty("spring.security.filter.order", Integer.class,
                SECURITY_FILTER_ORDER);
        if (settings.filterOrder() >= securityOrder) {
            throw new IllegalStateException("sendproof.filter-order (" + settings.filterOrder()
                    + ") must be lower than spring.security.filter.order (" + securityOrder
                    + ") so previews are authorized as the real operation.");
        }
        var registration = new FilterRegistrationBean<>(new SendproofFilter(new PreviewTargets(handlerMappings)));
        registration.setName("sendproofFilter");
        registration.addUrlPatterns("/*");
        // Before Spring Security (-100) so the rewritten request is authenticated and authorized as the real one.
        registration.setOrder(settings.filterOrder());
        return registration;
    }

    @Bean
    SendproofInterceptor sendproofInterceptor(PreviewProviders providers, WorkbenchAccess access,
                                              TraceOwnerResolver owners, TraceStore traces) {
        return new SendproofInterceptor(providers, access, owners, traces);
    }

    @Bean
    WebMvcConfigurer sendproofWebMvcConfigurer(SendproofInterceptor interceptor) {
        return new WebMvcConfigurer() {
            @Override
            public void addInterceptors(InterceptorRegistry registry) {
                // First, so the provider's transaction encloses every other interceptor and the handler.
                registry.addInterceptor(interceptor).order(Ordered.HIGHEST_PRECEDENCE);
            }
        };
    }

    @Bean
    WorkbenchController sendproofWorkbenchController(SendproofSettings settings, Environment environment,
                                                     PreviewProviders providers, PreviewOperations operations,
                                                     OpenApiDocuments documents, WorkbenchIdentityResolver identities,
                                                     WorkbenchAccess access, TraceOwnerResolver owners,
                                                     TraceStore traces, WorkbenchAssets assets) {
        return new WorkbenchController(settings, environment, providers, operations, documents, identities, access,
                owners, traces, assets);
    }

    /** Identity from Spring Security when it is present. */
    @Configuration(proxyBeanMethods = false)
    @ConditionalOnClass(name = "org.springframework.security.core.context.SecurityContextHolder")
    static class SecurityConfiguration {
        @Bean
        @ConditionalOnMissingBean(WorkbenchIdentityResolver.class)
        WorkbenchIdentityResolver sendproofSecurityIdentityResolver(ObjectProvider<Sendproof> builder) {
            Sendproof configured = builder.getIfAvailable();
            return configured != null && configured.identity() != null ? configured.identity()
                    : new SecurityIdentityResolver();
        }
    }

    /** OpenAPI discovery from springdoc when it is present. */
    @Configuration(proxyBeanMethods = false)
    @ConditionalOnClass(GroupedOpenApi.class)
    static class SpringdocConfiguration {
        @Bean
        @ConditionalOnMissingBean(OpenApiDocuments.class)
        OpenApiDocuments sendproofSpringdocDocuments(Environment environment, SendproofSettings settings,
                                                      ObjectProvider<GroupedOpenApi> groups) {
            return new SpringdocOpenApiDocuments(environment, settings, groups.orderedStream().toList());
        }
    }

    /** Log capture when Logback is the logging backend. */
    @Configuration(proxyBeanMethods = false)
    @ConditionalOnClass(name = "ch.qos.logback.classic.LoggerContext")
    static class LogbackConfiguration {
        @Bean
        LogbackCaptureInstaller sendproofLogbackCaptureInstaller() {
            return new LogbackCaptureInstaller();
        }
    }

    @Bean
    @ConditionalOnMissingBean(WorkbenchIdentityResolver.class)
    WorkbenchIdentityResolver sendproofPrincipalIdentityResolver(ObjectProvider<Sendproof> builder) {
        Sendproof configured = builder.getIfAvailable();
        return configured != null && configured.identity() != null ? configured.identity()
                : new PrincipalIdentityResolver();
    }
}
