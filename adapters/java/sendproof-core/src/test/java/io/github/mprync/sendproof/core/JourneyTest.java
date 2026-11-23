package io.github.mprync.sendproof.core;

import static io.github.mprync.sendproof.core.Journey.inputRef;
import static io.github.mprync.sendproof.core.Journey.outputRef;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import java.time.LocalDate;
import java.util.Map;
import org.junit.jupiter.api.Test;

class JourneyTest {
    private static final String OPEN_API = """
            {"paths": {"/orders": {"post": {"operationId": "createOrder"}},
                       "/orders/{id}": {"patch": {"operationId": "shipOrder"}}}}
            """;

    private record Inputs(String customer) {}

    @Test
    void generationPreservesBindingsAndExpectations() throws Exception {
        var files = new JourneyFiles();
        files.register(Journey.define("checkout").name("Checkout journeys").summary("Place and ship an order")
                .group("Orders").runAs("admin@example.test").definedIn(JourneyTest.class)
                .inputs(Inputs.class)
                .step("create", "createOrder", step -> step
                        .body(Map.of("customer", inputRef("customer")))
                        .outputFromBody("id", "/id").succeedsWith(201)
                        .expectWrites(writes -> writes
                                .sql("h2", "Orders", "insert", Map.of("Id", outputRef("create", "id")),
                                        Map.of("CreatedAt", Match.any("date-time")))))
                .step("ship", "shipOrder", step -> step
                        .parameter(Journey.In.PATH, "id", outputRef("create", "id"))
                        .succeedsWith(200).runAs("shipping@example.test")
                        .expectWrites(writes -> writes
                                .mongo("orders", "update", Map.of("_id", outputRef("create", "id")),
                                        Map.of("status", Match.changed("paid", "shipped")))
                                .redis("order:{" + outputRef("create", "id") + "}", "set")
                                .email(inputRef("customer"), Match.pattern("shipped")))
                        .approvedDifference(new Journey.ApprovedDifference("AD-1",
                                Map.of("store", "mongodb", "collection", "orders", "field", "status"),
                                "shipped", "dispatched", "Status renamed", "reviewer@example.test",
                                LocalDate.of(2026, 11, 23), null, null))));
        JsonNode openApi = Json.MAPPER.readTree(OPEN_API);
        files.startCode("/openapi.json", () -> openApi, true);

        assertThat(files.discover("/tenant")).containsExactly(new Capabilities.Journey("Checkout journeys", "code",
                "/tenant/sendproof/journeys/checkout.arazzo.json", "/tenant/sendproof/journeys/checkout.expect.json"));
        JsonNode ar = files.find("journeys/checkout.arazzo.json", "/tenant");
        assertThat(ar.at("/sourceDescriptions/0/url").textValue()).isEqualTo("/tenant/openapi.json");
        assertThat(ar.at("/workflows/0/steps/0/requestBody/payload/customer").textValue()).isEqualTo("$inputs.customer");
        assertThat(ar.at("/workflows/0/steps/0/outputs/id").textValue()).isEqualTo("$response.body#/id");
        assertThat(ar.at("/workflows/0/steps/1/parameters/0/value").textValue()).isEqualTo("$steps.create.outputs.id");

        JsonNode expected = files.find("journeys/checkout.expect.json", "");
        assertThat(expected.path("journeys").path("checkout")).isEqualTo(Json.MAPPER.readTree("""
                {"group":"Orders", "runAs":"admin@example.test", "definedIn":{"type":"JourneyTest"},
                 "sendOnly":true, "sendOnlyReason":"Step ship writes to Redis, which can't roll back.",
                 "steps":{
                   "create":{"unlisted":"fail","writes":[
                     {"store":"h2","table":"Orders","op":"insert","key":{"Id":"$steps.create.outputs.id"},
                      "values":{"CreatedAt":{"type":"date-time"}}}]},
                   "ship":{"persona":"shipping@example.test","unlisted":"fail","writes":[
                     {"store":"mongodb","collection":"orders","op":"update","key":{"_id":"$steps.create.outputs.id"},
                      "values":{"status":{"from":"paid","to":"shipped"}}},
                     {"store":"redis","key":"order:{$steps.create.outputs.id}","op":"SET"}],
                     "effects":[{"kind":"email","to":"$inputs.customer","subject":{"pattern":"shipped"}}]}
                 }}
                """));
        assertThat(expected.at("/approvedDifferences/0")).isEqualTo(Json.MAPPER.readTree("""
                {"id":"AD-1","journey":"checkout","step":"ship","kind":"value",
                 "target":{"store":"mongodb","collection":"orders","field":"status"},
                 "expected":"shipped","actual":"dispatched","reason":"Status renamed",
                 "approvedBy":"reviewer@example.test","approvedOn":"2026-11-23"}
                """));
    }

    @Test
    void developmentRejectsInvalidReferencesAndProductionPublishesOnlyValidJourneys() throws Exception {
        var files = new JourneyFiles();
        files.register(Journey.define("broken").inputs(Inputs.class)
                .step("first", "wrongOperation", step -> step
                        .body(Map.of("customer", inputRef("missing"), "id", outputRef("later", "id"))))
                .step("later", "shipOrder", step -> step
                        .parameter(Journey.In.PATH, "id", outputRef("first", "undeclared"))
                        .outputFromBody("id", "/id")));
        files.register(Journey.define("valid").step("create", "createOrder", step -> step.succeedsWith(201)));
        JsonNode openApi = Json.MAPPER.readTree(OPEN_API);

        assertThatThrownBy(() -> files.startCode("/openapi.json", () -> openApi, true))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("broken: Step first: unknown OpenAPI operationId wrongOperation")
                .hasMessageContaining("Step first: unknown input reference $inputs.missing")
                .hasMessageContaining("Step first: invalid step output reference $steps.later.outputs.id")
                .hasMessageContaining("Step later: invalid step output reference $steps.first.outputs.undeclared");
        assertThat(files.discover("")).isEmpty();

        files.startCode("/openapi.json", () -> openApi, false);
        assertThat(files.discover("")).extracting(Capabilities.Journey::name).containsExactly("valid");
        assertThat(files.find("journeys/broken.arazzo.json", "")).isNull();
    }
}
