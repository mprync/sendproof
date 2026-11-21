package io.github.mprync.sendproof.fixture;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/** Readiness probe used by the conformance runner. */
@RestController
public class ReadyController {

    @GetMapping("/ready")
    public String ready() {
        return "ok";
    }
}
