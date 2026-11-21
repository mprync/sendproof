package dev.testbench.jpa.testapp;

import dev.testbench.spring.TestBenchPreview;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.bind.annotation.RestController;

@RestController
@TestBenchPreview
public class WidgetController {
    private final WidgetService widgets;

    public WidgetController(WidgetService widgets) {
        this.widgets = widgets;
    }

    @PostMapping("/widgets/{id}")
    public ResponseEntity<String> create(@PathVariable String id, @RequestParam(defaultValue = "Bolt") String name) {
        widgets.create(id, name);
        return ResponseEntity.status(HttpStatus.CREATED).body(id);
    }

    @PatchMapping("/widgets/{id}")
    public String rename(@PathVariable String id, @RequestParam String name) {
        widgets.rename(id, name);
        return name;
    }

    @DeleteMapping("/widgets/{id}")
    public ResponseEntity<Void> delete(@PathVariable String id) {
        widgets.delete(id);
        return ResponseEntity.noContent().build();
    }

    @PostMapping("/bulk/{prefix}")
    public String bulk(@PathVariable String prefix) {
        widgets.createMany(prefix, 205);
        return "ok";
    }

    @PostMapping("/jdbc/{id}")
    public String jdbc(@PathVariable String id) {
        widgets.jdbcInsert(id);
        return id;
    }

    @PostMapping("/escape/new-transaction/{id}")
    public String newTransaction(@PathVariable String id) {
        widgets.createInNewTransaction(id);
        return id;
    }

    @PostMapping("/escape/autocommit/{id}")
    public String autocommit(@PathVariable String id) {
        widgets.jdbcInsertOutsideTransaction(id);
        return id;
    }

    @PostMapping("/escape/connection-commit/{id}")
    public String connectionCommit(@PathVariable String id) {
        widgets.commitThroughTheConnection(id);
        return id;
    }

    @PostMapping("/escape/sql-commit/{id}")
    public String sqlCommit(@PathVariable String id) {
        widgets.commitWithSql(id);
        return id;
    }

    @PostMapping("/logins/{id}")
    public ResponseEntity<String> login(@PathVariable String id) {
        widgets.createLogin(id, "s3cret-hash");
        return ResponseEntity.status(HttpStatus.CREATED).body(id);
    }

    @RestControllerAdvice
    static class Errors {
        @ExceptionHandler(DataIntegrityViolationException.class)
        ResponseEntity<String> conflict(DataIntegrityViolationException error) {
            return ResponseEntity.status(HttpStatus.CONFLICT).body("duplicate");
        }
    }
}
