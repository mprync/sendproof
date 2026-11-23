package io.github.mprync.sendproof.spring;

import io.github.mprync.sendproof.core.DataStore;
import io.github.mprync.sendproof.core.PreviewProvider;
import io.github.mprync.sendproof.core.PreviewSessions;
import io.github.mprync.sendproof.core.TraceStore;
import io.github.mprync.sendproof.core.WorkbenchAssets;
import org.springdoc.core.models.GroupedOpenApi;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.boot.autoconfigure.web.servlet.DispatcherServletPath;
import org.springframework.boot.autoconfigure.web.servlet.WebMvcAutoConfiguration;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.ApplicationContext;
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
    PreviewSessions sendproofPreviewSessions() {
        return new PreviewSessions();
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

    /** Every data store: the builder's, any {@link DataStore} bean, and the automatic Spring Data ones. */
    @Bean
    SendproofStores sendproofStores(SendproofSettings settings, ObjectProvider<DataStore> beans) {
        var registered = new java.util.ArrayList<DataStore>(settings.dataStores());
        beans.orderedStream().filter(store -> !registered.contains(store)).forEach(registered::add);
        return new SendproofStores(registered);
    }

    @Bean
    PreviewProviders sendproofPreviewProviders(ObjectProvider<PreviewProvider> providers) {
        return new PreviewProviders(providers);
    }

    /** Client beans of a registered store Sendproof can't guard; while any exists, every Preview is refused. */
    @Bean
    UnguardedClients sendproofUnguardedClients(org.springframework.beans.factory.ListableBeanFactory beans,
                                               ObjectProvider<SendproofStores> stores, Environment environment) {
        return new UnguardedClients(beans, stores, environment);
    }

    @Bean
    PreviewOperations sendproofPreviewOperations(ObjectProvider<RequestMappingHandlerMapping> mappings, UnguardedClients unguarded) {
        return new PreviewOperations(mappings, unguarded);
    }

    @Bean
    @ConditionalOnMissingBean(OpenApiDocuments.class)
    OpenApiDocuments sendproofOpenApiDocuments(SendproofSettings settings) {
        return new PropertyOpenApiDocuments(settings, "/v3/api-docs");
    }

    @Bean
    JourneyStartup sendproofJourneyStartup(SendproofSettings settings, OpenApiDocuments documents,
                                          ApplicationContext context, ObjectProvider<DispatcherServletPath> servlet) {
        return new JourneyStartup(settings, documents, context, servlet);
    }

    @Bean
    FilterRegistrationBean<SendproofFilter> sendproofFilter(SendproofSettings settings, Environment environment,
                                                            ObjectProvider<HandlerMapping> handlerMappings,
                                                            UnguardedClients unguarded) {
        // The preview must be rewritten before Spring Security sees it; otherwise the security rules would be matched
        // against /sendproof/_preview/... instead of the real operation's path.
        int securityOrder = environment.getProperty("spring.security.filter.order", Integer.class,
                SECURITY_FILTER_ORDER);
        if (settings.filterOrder() >= securityOrder) {
            throw new IllegalStateException("sendproof.filter-order (" + settings.filterOrder()
                    + ") must be lower than spring.security.filter.order (" + securityOrder
                    + ") so previews are authorized as the real operation.");
        }
        var registration = new FilterRegistrationBean<>(new SendproofFilter(new PreviewTargets(handlerMappings, unguarded)));
        registration.setName("sendproofFilter");
        registration.addUrlPatterns("/*");
        // Before Spring Security (-100) so the rewritten request is authenticated and authorized as the real one.
        registration.setOrder(settings.filterOrder());
        return registration;
    }

    @Bean
    SendproofInterceptor sendproofInterceptor(PreviewProviders providers, SendproofStores stores, WorkbenchAccess access,
                                              TraceOwnerResolver owners, WorkbenchIdentityResolver identities,
                                              TraceStore traces, PreviewSessions sessions) {
        return new SendproofInterceptor(providers, stores, access, owners, identities, traces, sessions);
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
                                                     PreviewProviders providers, SendproofStores stores,
                                                     PreviewOperations operations,
                                                     OpenApiDocuments documents, WorkbenchIdentityResolver identities,
                                                     WorkbenchAccess access, TraceOwnerResolver owners,
                                                     TraceStore traces, WorkbenchAssets assets, PreviewSessions sessions,
                                                     UnguardedClients unguarded) {
        return new WorkbenchController(settings, environment, providers, stores, operations, documents, identities,
                access, owners, traces, assets, sessions, unguarded);
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

    /** Hooks a Spring Data MongoDB database factory. Static: post-processors are created before the beans they wrap. */
    @Configuration(proxyBeanMethods = false)
    @ConditionalOnClass(name = "org.springframework.data.mongodb.MongoDatabaseFactory")
    static class MongoHookConfiguration {
        @Bean
        static MongoStoreHook sendproofMongoStoreHook(Environment environment) {
            return new MongoStoreHook(environment);
        }
    }

    /** Hooks a Spring Data Redis connection factory. Static: post-processors are created before the beans they wrap. */
    @Configuration(proxyBeanMethods = false)
    @ConditionalOnClass(name = "org.springframework.data.redis.connection.RedisConnectionFactory")
    static class RedisHookConfiguration {
        @Bean
        static RedisStoreHook sendproofRedisStoreHook(Environment environment) {
            return new RedisStoreHook(environment);
        }
    }

    /** Hooks every Cassandra session bean. Static: post-processors are created before the beans they wrap. */
    @Configuration(proxyBeanMethods = false)
    @ConditionalOnClass(name = "com.datastax.oss.driver.api.core.CqlSession")
    static class CassandraHookConfiguration {
        @Bean
        static CassandraStoreHook sendproofCassandraStoreHook(Environment environment) {
            return new CassandraStoreHook(environment);
        }
    }

    /** Hooks every Elasticsearch and OpenSearch transport bean (the hook checks which library is present). Static: post-processors are created before the beans they wrap. */
    @Configuration(proxyBeanMethods = false)
    static class SearchHookConfiguration {
        @Bean
        static SearchStoreHook sendproofSearchStoreHook(Environment environment) {
            return new SearchStoreHook(environment);
        }
    }

    /** Hooks the low-level Elasticsearch {@code RestClient} Spring Boot builds, which is a bean an application can inject. */
    @Configuration(proxyBeanMethods = false)
    @ConditionalOnClass(name = {"org.springframework.boot.autoconfigure.elasticsearch.RestClientBuilderCustomizer",
            "org.elasticsearch.client.RestClientBuilder", "co.elastic.clients.transport.ElasticsearchTransport"})
    static class ElasticsearchRestClientHookConfiguration {
        @Bean
        ElasticsearchRestClientHook sendproofElasticsearchRestClientHook(SendproofStores stores, Environment environment) {
            return new ElasticsearchRestClientHook(stores, environment);
        }
    }

    /** Hooks every Firestore bean. Static: post-processors are created before the beans they wrap. */
    @Configuration(proxyBeanMethods = false)
    @ConditionalOnClass(name = "com.google.cloud.firestore.Firestore")
    static class FirestoreHookConfiguration {
        @Bean
        static FirestoreStoreHook sendproofFirestoreStoreHook(Environment environment) {
            return new FirestoreStoreHook(environment);
        }
    }

    /** The MongoDB tripwire: the command listener of the Spring Data store joins the auto-configured client. */
    @Configuration(proxyBeanMethods = false)
    @ConditionalOnClass(name = {"org.springframework.data.mongodb.MongoDatabaseFactory", "com.mongodb.client.MongoClient"})
    static class MongoTripwireConfiguration {
        @Bean
        org.springframework.boot.autoconfigure.mongo.MongoClientSettingsBuilderCustomizer sendproofMongoTripwire(
                ObjectProvider<SendproofStores> stores, Environment environment) {
            return settings -> {
                if (environment.getProperty("sendproof.stores.mongodb.enabled", Boolean.class, true)) {
                    settings.addCommandListener(stores.getObject().of(io.github.mprync.sendproof.mongodb.MongoStore.class,
                            () -> io.github.mprync.sendproof.mongodb.MongoStore.springData()
                                    .name(environment.getProperty("sendproof.stores.mongodb.name")).build()).commandListener());
                }
            };
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
