package io.github.mprync.sendproof.fixture;

import static org.junit.jupiter.api.Assertions.assertEquals;

import io.github.mprync.sendproof.core.JourneyFiles;
import io.github.mprync.sendproof.core.Json;
import org.junit.jupiter.api.Test;

class JourneyGoldenTest {
    @Test
    void generatedDocumentsMatchTheFileJourney() throws Exception {
        var files = new JourneyFiles();
        files.register(FixtureApplication.conformanceJourney());
        var openApi = Json.MAPPER.readTree("""
                {"paths": {"/items/{id}": {"get": {"operationId": "getItem"}}}}
                """);
        files.startCode("/v3/api-docs", () -> openApi, true);
        assertEquals("code", files.discover("").get(0).source());
        for (String file : new String[] {"conformance.arazzo.json", "conformance.expect.json"}) {
            try (var expected = getClass().getResourceAsStream("/journeys/" + file)) {
                assertEquals(Json.MAPPER.readTree(expected), files.find("journeys/" + file, ""), file);
            }
        }
    }
}
