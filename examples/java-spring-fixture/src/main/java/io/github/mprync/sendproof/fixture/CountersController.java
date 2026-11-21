package io.github.mprync.sendproof.fixture;

import io.github.mprync.sendproof.spring.SendproofPreview;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** The Redis routes of the fixture contract, through {@code StringRedisTemplate}. Counters live at {@code <prefix>counter:<key>}. */
@RestController
@RequestMapping("/counters")
@ConditionalOnProperty("bench.redis.url")
public class CountersController {
    private final StringRedisTemplate redis;
    private final String prefix;

    public CountersController(StringRedisTemplate redis, @Value("${bench.redis.prefix}") String prefix) {
        this.redis = redis;
        this.prefix = prefix;
    }

    private String key(String key) {
        return prefix + "counter:" + key;
    }

    @SendproofPreview
    @GetMapping("/{key}")
    public ResponseEntity<Map<String, Object>> get(@PathVariable String key) {
        String value = redis.opsForValue().get(key(key));
        return value == null ? ResponseEntity.notFound().build()
                : ResponseEntity.ok(Map.of("key", key, "value", Long.parseLong(value)));
    }

    @SendproofPreview
    @PostMapping("/{key}")
    public Map<String, Object> increment(@PathVariable String key) {
        return Map.of("key", key, "value", redis.opsForValue().increment(key(key)));
    }

    /** GETDEL looks like a read but deletes the key: a write. */
    @SendproofPreview
    @PostMapping("/{key}/take")
    public ResponseEntity<Map<String, Object>> take(@PathVariable String key) {
        String value = redis.opsForValue().getAndDelete(key(key));
        return value == null ? ResponseEntity.notFound().build()
                : ResponseEntity.ok(Map.of("key", key, "value", Long.parseLong(value)));
    }

    @SendproofPreview(enabled = false, stores = "redis")
    @DeleteMapping("/{key}")
    public ResponseEntity<Void> delete(@PathVariable String key) {
        redis.delete(key(key));
        return ResponseEntity.noContent().build();
    }
}
