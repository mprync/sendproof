package io.github.mprync.sendproof.fixture;

import org.springframework.boot.availability.ApplicationAvailability;
import org.springframework.boot.availability.ReadinessState;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/** Readiness probe used by the conformance runner. */
@RestController
public class ReadyController {
    private final ApplicationAvailability availability;

    public ReadyController(ApplicationAvailability availability) {
        this.availability = availability;
    }

    @GetMapping("/ready")
    public ResponseEntity<String> ready() {
        return availability.getReadinessState() == ReadinessState.ACCEPTING_TRAFFIC
                ? ResponseEntity.ok("ok") : ResponseEntity.status(503).build();
    }
}
