package io.github.mprync.sendproof.fixture;

import io.github.mprync.sendproof.dynamodb.DynamoDbStore;
import java.net.URI;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.dynamodb.DynamoDbClient;

/**
 * The DynamoDB client of the conformance fixture, configured only when the runner passes {@code BENCH_DYNAMODB_URL}.
 * Sendproof hooks the Spring Data MongoDB and Redis clients on its own; an AWS SDK client is built by the application, so
 * its interceptor is added by hand.
 */
@Configuration
public class StoresConfiguration {

    /** An AWS SDK v2 client with the Sendproof interceptor, against DynamoDB Local. */
    @Configuration
    @ConditionalOnProperty("bench.dynamodb.url")
    static class Dynamo {
        @Bean
        DynamoDbStore ordersStore() {
            return DynamoDbStore.interceptor().name("orders").build();
        }

        @Bean(destroyMethod = "close")
        DynamoDbClient dynamoDbClient(DynamoDbStore ordersStore,
                                      @org.springframework.beans.factory.annotation.Value("${bench.dynamodb.url}") String url,
                                      @org.springframework.beans.factory.annotation.Value("${aws.region:us-east-1}") String region) {
            return DynamoDbClient.builder().endpointOverride(URI.create(url)).region(Region.of(region))
                    .overrideConfiguration(config -> config.addExecutionInterceptor(ordersStore)).build();
        }
    }
}
