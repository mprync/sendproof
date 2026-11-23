package io.github.mprync.sendproof.fixture

import io.github.mprync.sendproof.core.JourneyFiles
import io.github.mprync.sendproof.core.Json
import kotlin.test.Test
import kotlin.test.assertEquals

class JourneyGoldenTest {
    @Test
    fun generatedDocumentsMatchTheFileJourney() {
        val files = JourneyFiles()
        files.register(conformanceJourney())
        val openApi = javaClass.getResourceAsStream("/openapi.json")!!.use { Json.MAPPER.readTree(it) }
        files.startCode("/openapi.json", { openApi }, true)
        assertEquals("code", files.discover("").single().source())
        for (file in listOf("conformance.arazzo.json", "conformance.expect.json")) {
            val expected = javaClass.getResourceAsStream("/journeys/$file")!!.use { Json.MAPPER.readTree(it) }
            assertEquals(expected, files.find("journeys/$file", ""), file)
        }
    }
}
