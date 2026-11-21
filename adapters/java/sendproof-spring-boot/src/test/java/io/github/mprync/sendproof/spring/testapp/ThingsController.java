package io.github.mprync.sendproof.spring.testapp;

import io.github.mprync.sendproof.core.SendproofCapture;
import io.github.mprync.sendproof.spring.SendproofPreview;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
public class ThingsController {
    private static final Logger LOG = LoggerFactory.getLogger(ThingsController.class);
    private final SendproofCapture capture;

    public ThingsController(SendproofCapture capture) {
        this.capture = capture;
    }

    @SendproofPreview
    @PostMapping("/things")
    public ResponseEntity<Map<String, String>> create() {
        LOG.info("created thing");
        boolean suppressed = capture.tryRecordEmail("Created thing", "from@example.test", List.of("to@example.test"),
                List.of(), "Subject", "Body", null);
        return ResponseEntity.status(HttpStatus.CREATED).body(Map.of("suppressed", String.valueOf(suppressed)));
    }

    @SendproofPreview
    @PatchMapping("/things/{id:\\d+}")
    public Map<String, String> patch(@PathVariable String id) {
        return Map.of("id", id);
    }

    @SendproofPreview
    @PostMapping("/things/conflict")
    public void conflict() {
        throw new ResponseStatusException(HttpStatus.CONFLICT, "handled");
    }

    @SendproofPreview
    @PostMapping("/things/boom")
    public void boom() {
        throw new IllegalStateException("unhandled");
    }

    @SendproofPreview
    @PostMapping("/things/large")
    public String large() {
        return "x".repeat(1_200_000);
    }

    @SendproofPreview
    @PostMapping("/things/redirect")
    public ResponseEntity<Void> redirect() {
        return ResponseEntity.status(HttpStatus.FOUND).header(HttpHeaders.LOCATION, "/things/1")
                .header(HttpHeaders.SET_COOKIE, "inner=1").build();
    }

    @PostMapping("/things/unmarked")
    public String unmarked() {
        return "ordinary";
    }

    @GetMapping("/things/{id}")
    public Map<String, String> read(@PathVariable String id) {
        return Map.of("id", id);
    }
}
