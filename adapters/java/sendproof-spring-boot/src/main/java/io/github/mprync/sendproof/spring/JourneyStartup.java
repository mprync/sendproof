package io.github.mprync.sendproof.spring;

import com.fasterxml.jackson.databind.JsonNode;
import io.github.mprync.sendproof.core.Json;
import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.Proxy;
import java.net.URI;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.boot.autoconfigure.web.servlet.DispatcherServletPath;
import org.springframework.boot.web.servlet.context.ServletWebServerApplicationContext;
import org.springframework.context.ApplicationContext;
import org.springframework.core.env.Profiles;

/** Reads the same OpenAPI route as discovery, after Spring MVC and the embedded server start. */
record JourneyStartup(SendproofSettings settings, OpenApiDocuments documents, ApplicationContext context,
                      ObjectProvider<DispatcherServletPath> servlet) implements ApplicationRunner {
    @Override
    public void run(ApplicationArguments args) {
        boolean development = "Development".equalsIgnoreCase(settings.environment())
                || (settings.environment() == null && context.getEnvironment().acceptsProfiles(Profiles.of("development", "dev")));
        settings.journeys().startCode(documents.primaryUrl(), this::readOpenApi, development);
    }

    private JsonNode readOpenApi() {
        JsonNode provided = documents.primaryDocument();
        if (provided != null) {
            return provided;
        }
        if (!(context instanceof ServletWebServerApplicationContext web) || web.getWebServer() == null) {
            throw new IllegalStateException("Supply OpenApiDocuments.primaryDocument() when using an external servlet container");
        }
        String mount = web.getServletContext().getContextPath();
        DispatcherServletPath dispatcher = servlet.getIfAvailable();
        if (dispatcher != null) {
            mount += dispatcher.getPrefix();
        }
        var environment = context.getEnvironment();
        String host = environment.getProperty("server.address", "127.0.0.1");
        if ("0.0.0.0".equals(host)) {
            host = "127.0.0.1";
        }
        if (host.contains(":") && !host.startsWith("[")) {
            host = "[" + host + "]";
        }
        String scheme = environment.getProperty("server.ssl.enabled", Boolean.class, false) ? "https" : "http";
        var uri = URI.create(scheme + "://" + host + ":" + web.getWebServer().getPort() + mount + documents.primaryUrl());
        try {
            var connection = (HttpURLConnection) uri.toURL().openConnection(Proxy.NO_PROXY);
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(5000);
            connection.setReadTimeout(5000);
            connection.setRequestProperty("Accept", "application/json");
            try {
                int status = connection.getResponseCode();
                if (status != 200) {
                    throw new IllegalStateException("HTTP " + status
                            + "; supply OpenApiDocuments.primaryDocument() for a protected OpenAPI endpoint");
                }
                try (var body = connection.getInputStream()) {
                    return Json.MAPPER.readTree(body);
                }
            } finally {
                connection.disconnect();
            }
        } catch (IOException error) {
            throw new IllegalStateException(error.getMessage(), error);
        }
    }
}
