package dev.testbench.fixture;

import dev.testbench.spring.TestBenchPreview;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import java.util.Map;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** The fixture's API. Every write except {@code ordinary} is marked for preview. */
@RestController
@RequestMapping("/items")
public class ItemsController {

    public record ItemResponse(String id, String name) {
    }

    public record CreateItem(@NotBlank String id, @NotBlank String name) {
    }

    public record RenameItem(@NotBlank String name) {
    }

    private final ItemService items;

    public ItemsController(ItemService items) {
        this.items = items;
    }

    @GetMapping("/{id}")
    public ResponseEntity<ItemResponse> get(@PathVariable String id) {
        Item item = items.find(id);
        return item == null ? ResponseEntity.notFound().build()
                : ResponseEntity.ok(new ItemResponse(item.getId(), item.getName()));
    }

    @TestBenchPreview
    @PostMapping
    public ResponseEntity<ItemResponse> create(@Valid @RequestBody CreateItem request) {
        Item item = items.create(request.id(), request.name());
        return ResponseEntity.status(HttpStatus.CREATED).body(new ItemResponse(item.getId(), item.getName()));
    }

    @TestBenchPreview
    @PatchMapping("/{id}")
    public ResponseEntity<ItemResponse> rename(@PathVariable String id, @Valid @RequestBody RenameItem request,
                                               @RequestParam(required = false) String tag) {
        Item item = items.rename(id, request.name());
        var response = ResponseEntity.ok();
        if (tag != null) {
            response.header("X-Fixture-Tag", tag);
        }
        return response.body(new ItemResponse(item.getId(), item.getName()));
    }

    @TestBenchPreview
    @DeleteMapping("/{id}")
    public ResponseEntity<Void> delete(@PathVariable String id) {
        items.delete(id);
        return ResponseEntity.noContent().build();
    }

    @TestBenchPreview
    @PostMapping("/{id}/fail")
    public ResponseEntity<Void> fail(@PathVariable String id, @RequestParam(required = false) String mode) {
        if ("exception".equals(mode)) {
            throw new IllegalStateException("Unhandled failure for " + id);
        }
        items.insertThenFail(id);
        return ResponseEntity.noContent().build();
    }

    @TestBenchPreview
    @PostMapping("/{id}/large")
    public Map<String, String> large(@PathVariable String id) {
        items.insert(id, "large");
        return Map.of("data", "x".repeat(1_500_000));
    }

    @TestBenchPreview
    @PostMapping("/{id}/redirect")
    public ResponseEntity<Void> redirect(@PathVariable String id, HttpServletRequest request) {
        return ResponseEntity.status(HttpStatus.FOUND)
                .header(HttpHeaders.LOCATION, request.getContextPath() + "/items/" + id)
                .header(HttpHeaders.SET_COOKIE, "fixture_inner=1; Path=/").build();
    }

    @TestBenchPreview
    @PostMapping("/{id}/capture")
    public Map<String, Integer> capture(@PathVariable String id) {
        return Map.of("created", items.capture(id));
    }

    /** Deliberately not marked: Preview must refuse it, ordinary Send must still work. */
    @PostMapping("/{id}/ordinary")
    public ResponseEntity<ItemResponse> ordinary(@PathVariable String id) {
        Item item = items.insert(id, "ordinary");
        return ResponseEntity.status(HttpStatus.CREATED).body(new ItemResponse(item.getId(), item.getName()));
    }
}
