package io.github.mprync.sendproof.fixture;

import java.util.concurrent.atomic.AtomicInteger;
import org.springframework.stereotype.Component;

/** A stand-in for an external dispatcher (mail, queue). It only counts deliveries. */
@Component
public class Outbox {
    private final AtomicInteger delivered = new AtomicInteger();

    public void deliver(String ignored) {
        delivered.incrementAndGet();
    }

    public int delivered() {
        return delivered.get();
    }
}
