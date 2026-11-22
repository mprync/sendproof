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

    /** An OpenSearch client over an Apache HttpClient 5 transport; Sendproof hooks the transport bean on its own. */
    @Configuration
    @ConditionalOnProperty("bench.opensearch.url")
    static class OpenSearch {
        @Bean(destroyMethod = "close")
        org.opensearch.client.transport.OpenSearchTransport openSearchTransport(
                @org.springframework.beans.factory.annotation.Value("${bench.opensearch.url}") String url) throws java.net.URISyntaxException {
            return org.opensearch.client.transport.httpclient5.ApacheHttpClient5TransportBuilder
                    .builder(org.apache.hc.core5.http.HttpHost.create(url))
                    .setMapper(new org.opensearch.client.json.jackson.JacksonJsonpMapper()).build();
        }

        @Bean
        org.opensearch.client.opensearch.OpenSearchClient openSearchClient(org.opensearch.client.transport.OpenSearchTransport transport) {
            return new org.opensearch.client.opensearch.OpenSearchClient(transport);
        }
    }

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
