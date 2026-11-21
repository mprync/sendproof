package io.github.mprync.sendproof.fixture;

import io.swagger.v3.oas.models.OpenAPI;
import io.swagger.v3.oas.models.info.Info;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/** Publishes the fixture's OpenAPI document through springdoc at its normal path. */
@Configuration
public class OpenApiConfig {

    @Bean
    OpenAPI fixtureOpenApi() {
        return new OpenAPI().info(new Info().title("Sendproof Conformance").version("1"));
    }
}
