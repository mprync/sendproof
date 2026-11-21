package dev.testbench.spring;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Configuration for the Test Bench workbench. Everything is off unless {@code testbench.enabled=true}, and it stays
 * off under a production profile unless {@code testbench.allow-in-production=true}.
 */
@ConfigurationProperties(prefix = "testbench")
public class TestBenchProperties {

    /** Master switch. The workbench, preview route and observed send exist only when this is true. */
    private boolean enabled;

    /** Allows the workbench while a profile listed in {@code blocked-profiles} is active. Discouraged. */
    private boolean allowInProduction;

    /** Profiles under which Test Bench refuses to start even when enabled. */
    private List<String> blockedProfiles = new ArrayList<>(List.of("prod", "production"));

    /** Display label for the environment; defaults to the first active profile. */
    private String environment;

    /** Display name of the API; defaults to {@code spring.application.name}. */
    private String apiName;

    /** The primary OpenAPI document URL, relative to the context path. Detected from springdoc when unset. */
    private String openApiUrl;

    /** Additional or explicit OpenAPI documents, relative to the context path. */
    private List<Document> documents = new ArrayList<>();

    /** Sign-in options shown in the workbench. URLs are relative to the context path. */
    private List<AuthProvider> authProviders = new ArrayList<>();

    /** Same-origin ES modules that add field renderers, relative to the context path. */
    private List<String> fieldModules = new ArrayList<>();

    /** Observed send trace retention. */
    private final Trace trace = new Trace();

    /** SQL capture options. */
    private final Sql sql = new Sql();

    /** Servlet filter order. It must run before Spring Security's filter chain (order -100). */
    private int filterOrder = -150;

    public boolean isEnabled() {
        return enabled;
    }

    public void setEnabled(boolean enabled) {
        this.enabled = enabled;
    }

    public boolean isAllowInProduction() {
        return allowInProduction;
    }

    public void setAllowInProduction(boolean allowInProduction) {
        this.allowInProduction = allowInProduction;
    }

    public List<String> getBlockedProfiles() {
        return blockedProfiles;
    }

    public void setBlockedProfiles(List<String> blockedProfiles) {
        this.blockedProfiles = blockedProfiles;
    }

    public String getEnvironment() {
        return environment;
    }

    public void setEnvironment(String environment) {
        this.environment = environment;
    }

    public String getApiName() {
        return apiName;
    }

    public void setApiName(String apiName) {
        this.apiName = apiName;
    }

    public String getOpenApiUrl() {
        return openApiUrl;
    }

    public void setOpenApiUrl(String openApiUrl) {
        this.openApiUrl = openApiUrl;
    }

    public List<Document> getDocuments() {
        return documents;
    }

    public void setDocuments(List<Document> documents) {
        this.documents = documents;
    }

    public List<AuthProvider> getAuthProviders() {
        return authProviders;
    }

    public void setAuthProviders(List<AuthProvider> authProviders) {
        this.authProviders = authProviders;
    }

    public List<String> getFieldModules() {
        return fieldModules;
    }

    public void setFieldModules(List<String> fieldModules) {
        this.fieldModules = fieldModules;
    }

    public Trace getTrace() {
        return trace;
    }

    public Sql getSql() {
        return sql;
    }

    public int getFilterOrder() {
        return filterOrder;
    }

    public void setFilterOrder(int filterOrder) {
        this.filterOrder = filterOrder;
    }

    /** A named OpenAPI document. */
    public static class Document {
        private String name;
        private String url;

        public String getName() {
            return name;
        }

        public void setName(String name) {
            this.name = name;
        }

        public String getUrl() {
            return url;
        }

        public void setUrl(String url) {
            this.url = url;
        }
    }

    /** A sign-in option. */
    public static class AuthProvider {
        private String label;
        private String kind;
        private String url;

        public String getLabel() {
            return label;
        }

        public void setLabel(String label) {
            this.label = label;
        }

        public String getKind() {
            return kind;
        }

        public void setKind(String kind) {
            this.kind = kind;
        }

        public String getUrl() {
            return url;
        }

        public void setUrl(String url) {
            this.url = url;
        }
    }

    /** Trace retention settings. */
    public static class Trace {
        /** How long an observed send's trace stays readable. */
        private Duration retention = Duration.ofMinutes(5);

        public Duration getRetention() {
            return retention;
        }

        public void setRetention(Duration retention) {
            this.retention = retention;
        }
    }

    /** SQL capture settings. */
    public static class Sql {
        /** Show bound values. Defaults to true only for development-like environments; secrets are always redacted. */
        private Boolean includeParameterValues;

        public Boolean getIncludeParameterValues() {
            return includeParameterValues;
        }

        public void setIncludeParameterValues(Boolean includeParameterValues) {
            this.includeParameterValues = includeParameterValues;
        }
    }
}
