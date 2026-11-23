package io.github.mprync.sendproof.spring;

import io.github.mprync.sendproof.core.Capabilities.AuthProvider;
import io.github.mprync.sendproof.core.Capabilities.OpenApiDocument;
import io.github.mprync.sendproof.core.DataStore;
import io.github.mprync.sendproof.core.JourneyFiles;
import io.github.mprync.sendproof.core.LocalUrl;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.nio.file.Path;
import java.util.Objects;

/**
 * Code-based configuration for Sendproof. Declare one as a bean next to your other configuration:
 *
 * <pre>{@code
 * @Bean
 * Sendproof sendproof() {
 *     return Sendproof.builder()
 *             .apiName("Inventory")
 *             .environment("Staging")
 *             .openApiDocument("Previous version", "/v3/api-docs/v0")
 *             .authProvider("Staff SSO", "oidc", "/account/sign-in")
 *             .workbenchAccess(request -> request.isUserInRole("developer"))
 *             .build();
 * }
 * }</pre>
 *
 * <h2>Data stores</h2>
 * {@code dataStore(...)} registers a MongoDB, Redis or DynamoDB hook, which also makes a Preview possible when the
 * application has no SQL provider. Spring Data MongoDB and Spring Data Redis are hooked automatically when they are on
 * the classpath; register a store here to name it or to declare reads the table doesn't know:
 *
 * <pre>{@code
 * Sendproof.builder()
 *         .dataStore(MongoStore.springData().name("catalog").build())
 *         .dataStore(RedisStore.spring().name("cache").build())
 *         .dataStore(DynamoDbStore.interceptor().name("orders").build())   // also add it to the client you build
 *         .build();
 * }</pre>
 *
 * <h2>Precedence</h2>
 * For each setting, the first of these that is present wins:
 * <ol>
 *   <li>an explicit Spring bean of the same type ({@link WorkbenchAccess}, {@link WorkbenchIdentityResolver},
 *       {@link TraceOwnerResolver}, {@link OpenApiDocuments});</li>
 *   <li>the value set on this builder;</li>
 *   <li>the {@code sendproof.*} property;</li>
 *   <li>the default (documented in {@code sendproof-spring-boot/README.md}).</li>
 * </ol>
 * A list you set on the builder (documents, auth providers, field modules) <em>replaces</em> the property list rather
 * than adding to it.
 *
 * <h2>Environment gating is not configurable here</h2>
 * Whether Sendproof exists at all is decided before any bean is created, from properties only:
 * {@code sendproof.enabled} (default {@code false}), {@code sendproof.blocked-profiles} (default {@code prod},
 * {@code production}) and {@code sendproof.allow-in-production}. Declaring this bean therefore never turns Sendproof on,
 * and no code path can enable it in a blocked profile. That keeps "off in production" a deployment decision.
 * {@code sendproof.filter-order} and {@code sendproof.sql.include-parameter-values} are also property-only: the
 * first is needed to register the filter, and the second when the {@code DataSource} is wrapped.
 */
public final class Sendproof {
    private final String apiName;
    private final String environment;
    private final String openApiUrl;
    private final List<OpenApiDocument> documents;
    private final List<AuthProvider> authProviders;
    private final List<String> fieldModules;
    private final Duration traceRetention;
    private final WorkbenchAccess access;
    private final WorkbenchIdentityResolver identity;
    private final TraceOwnerResolver traceOwner;
    private final List<DataStore> dataStores;
    private final JourneyFiles journeys;

    private Sendproof(Builder builder) {
        this.apiName = builder.apiName;
        this.environment = builder.environment;
        this.openApiUrl = builder.openApiUrl;
        this.documents = builder.documents == null ? null : List.copyOf(builder.documents);
        this.authProviders = builder.authProviders == null ? null : List.copyOf(builder.authProviders);
        this.fieldModules = builder.fieldModules == null ? null : List.copyOf(builder.fieldModules);
        this.traceRetention = builder.traceRetention;
        this.access = builder.access;
        this.identity = builder.identity;
        this.traceOwner = builder.traceOwner;
        this.dataStores = List.copyOf(builder.dataStores);
        this.journeys = builder.journeys.snapshot();
    }

    /** Starts a new configuration. */
    public static Builder builder() {
        return new Builder();
    }

    String apiName() {
        return apiName;
    }

    String environment() {
        return environment;
    }

    String openApiUrl() {
        return openApiUrl;
    }

    List<OpenApiDocument> documents() {
        return documents;
    }

    List<AuthProvider> authProviders() {
        return authProviders;
    }

    List<String> fieldModules() {
        return fieldModules;
    }

    Duration traceRetention() {
        return traceRetention;
    }

    WorkbenchAccess access() {
        return access;
    }

    WorkbenchIdentityResolver identity() {
        return identity;
    }

    TraceOwnerResolver traceOwner() {
        return traceOwner;
    }

    List<DataStore> dataStores() {
        return dataStores;
    }

    JourneyFiles journeys() {
        return journeys;
    }

    /** Fluent builder for {@link Sendproof}. URLs are application-relative and are validated immediately. */
    public static final class Builder {
        private String apiName;
        private String environment;
        private String openApiUrl;
        private List<OpenApiDocument> documents;
        private List<AuthProvider> authProviders;
        private List<String> fieldModules;
        private Duration traceRetention;
        private WorkbenchAccess access;
        private WorkbenchIdentityResolver identity;
        private TraceOwnerResolver traceOwner;
        private final List<DataStore> dataStores = new ArrayList<>();
        private final JourneyFiles journeys = new JourneyFiles();

        private Builder() {
        }

        /** Sets the display name of the API ({@code sendproof.api-name}). */
        public Builder apiName(String name) {
            this.apiName = requireText(name, "name");
            return this;
        }

        /** Sets the environment label shown in the workbench ({@code sendproof.environment}). */
        public Builder environment(String name) {
            this.environment = requireText(name, "name");
            return this;
        }

        /** Sets the primary OpenAPI document URL ({@code sendproof.open-api-url}); it overrides springdoc discovery. */
        public Builder openApiUrl(String url) {
            this.openApiUrl = LocalUrl.validate(url);
            return this;
        }

        /** Adds an OpenAPI document. Calling this replaces the {@code sendproof.documents} property list. */
        public Builder openApiDocument(String name, String url) {
            if (documents == null) {
                documents = new ArrayList<>();
            }
            documents.add(new OpenApiDocument(requireText(name, "name"), LocalUrl.validate(url)));
            return this;
        }

        /** Adds a sign-in option. Calling this replaces the {@code sendproof.auth-providers} property list. */
        public Builder authProvider(String label, String kind, String url) {
            if (authProviders == null) {
                authProviders = new ArrayList<>();
            }
            authProviders.add(new AuthProvider(requireText(label, "label"), requireText(kind, "kind"),
                    url == null ? null : LocalUrl.validate(url)));
            return this;
        }

        /** Adds a same-origin ES module of field renderers. Calling this replaces {@code sendproof.field-modules}. */
        public Builder fieldModule(String url) {
            if (fieldModules == null) {
                fieldModules = new ArrayList<>();
            }
            fieldModules.add(LocalUrl.validate(url));
            return this;
        }

        /** Sets how long an observed send's trace stays readable ({@code sendproof.trace.retention}). */
        public Builder traceRetention(Duration retention) {
            Objects.requireNonNull(retention, "retention");
            if (retention.isZero() || retention.isNegative()) {
                throw new IllegalArgumentException("The trace retention must be positive.");
            }
            this.traceRetention = retention;
            return this;
        }

        /** Sets the extra access policy for the workbench and every preview; a {@link WorkbenchAccess} bean wins. */
        public Builder workbenchAccess(WorkbenchAccess access) {
            this.access = Objects.requireNonNull(access, "access");
            return this;
        }

        /** Sets the identity shown in the workbench; a {@link WorkbenchIdentityResolver} bean wins. */
        public Builder identityResolver(WorkbenchIdentityResolver resolver) {
            this.identity = Objects.requireNonNull(resolver, "resolver");
            return this;
        }

        /** Sets how trace owners are derived; a {@link TraceOwnerResolver} bean wins. */
        public Builder traceOwnerResolver(TraceOwnerResolver resolver) {
            this.traceOwner = Objects.requireNonNull(resolver, "resolver");
            return this;
        }

        /**
         * Registers a data store hook: {@code MongoStore}, {@code RedisStore} or {@code DynamoDbStore}. Stores listed
         * here are in addition to any {@link DataStore} beans and to the Spring Data hooks Spring Boot adds itself.
         */
        public Builder dataStore(DataStore store) {
            this.dataStores.add(Objects.requireNonNull(store, "store"));
            return this;
        }

        /** Builds the configuration. */
        /** Registers an Arazzo resource and its adjacent {@code .expect.json} file from the application classpath. */
        public Builder journey(String classpathResource) {
            journeys.registerResource(classpathResource, org.springframework.util.ClassUtils.getDefaultClassLoader());
            return this;
        }

        /** Registers an Arazzo file and its adjacent {@code .expect.json} file from the filesystem. */
        public Builder journey(Path file) {
            journeys.register(file);
            return this;
        }

        public Sendproof build() {
            return new Sendproof(this);
        }

        private static String requireText(String value, String name) {
            if (value == null || value.isBlank()) {
                throw new IllegalArgumentException("The " + name + " is required.");
            }
            return value;
        }
    }
}
