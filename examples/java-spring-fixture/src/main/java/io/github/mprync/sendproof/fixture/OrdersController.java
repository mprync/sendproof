package io.github.mprync.sendproof.fixture;

import io.github.mprync.sendproof.spring.SendproofPreview;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import software.amazon.awssdk.services.dynamodb.DynamoDbClient;
import software.amazon.awssdk.services.dynamodb.model.AttributeValue;
import software.amazon.awssdk.services.dynamodb.model.DeleteItemRequest;
import software.amazon.awssdk.services.dynamodb.model.ExecuteStatementRequest;
import software.amazon.awssdk.services.dynamodb.model.GetItemRequest;
import software.amazon.awssdk.services.dynamodb.model.UpdateItemRequest;

/** The DynamoDB routes of the fixture contract, through the AWS SDK v2 client the Sendproof interceptor is on. */
@RestController
@RequestMapping("/orders")
@ConditionalOnProperty("bench.dynamodb.url")
public class OrdersController {
    private final DynamoDbClient dynamo;
    private final String table;

    public OrdersController(DynamoDbClient dynamo, @Value("${bench.dynamodb.table}") String table) {
        this.dynamo = dynamo;
        this.table = table;
    }

    private static Map<String, Object> view(Map<String, AttributeValue> item) {
        var view = new LinkedHashMap<String, Object>();
        view.put("id", item.get("id").s());
        view.put("status", item.get("status").s());
        view.put("hits", Integer.parseInt(item.get("hits").n()));
        return view;
    }

    @SendproofPreview
    @GetMapping("/{id}")
    public ResponseEntity<Map<String, Object>> get(@PathVariable String id) {
        var response = dynamo.getItem(GetItemRequest.builder().tableName(table).key(Map.of("id", AttributeValue.fromS(id))).build());
        return response.hasItem() ? ResponseEntity.ok(view(response.item())) : ResponseEntity.notFound().build();
    }

    @SendproofPreview
    @PostMapping("/{id}/touch")
    public Map<String, Object> touch(@PathVariable String id) {
        return view(touchItem(id));
    }

    /** Shared with the mixed SQL and store route. */
    Map<String, AttributeValue> touchItem(String id) {
        return dynamo.updateItem(UpdateItemRequest.builder().tableName(table).key(Map.of("id", AttributeValue.fromS(id)))
                .updateExpression("ADD hits :one SET #s = if_not_exists(#s, :new)")
                .expressionAttributeNames(Map.of("#s", "status"))
                .expressionAttributeValues(Map.of(":one", AttributeValue.fromN("1"), ":new", AttributeValue.fromS("new")))
                .returnValues("ALL_NEW").build()).attributes();
    }

    /** A PartiQL UPDATE travels through ExecuteStatement, which also carries reads. */
    @SendproofPreview
    @PostMapping("/{id}/cancel")
    public Map<String, Object> cancel(@PathVariable String id) {
        dynamo.executeStatement(ExecuteStatementRequest.builder()
                .statement("UPDATE \"" + table + "\" SET status = 'cancelled' WHERE id = ?")
                .parameters(AttributeValue.fromS(id)).build());
        return Map.of("id", id, "status", "cancelled");
    }

    @SendproofPreview(enabled = false, stores = "dynamodb")
    @DeleteMapping("/{id}")
    public ResponseEntity<Void> delete(@PathVariable String id) {
        dynamo.deleteItem(DeleteItemRequest.builder().tableName(table).key(Map.of("id", AttributeValue.fromS(id))).build());
        return ResponseEntity.noContent().build();
    }
}
