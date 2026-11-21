package dynamobench_test

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/aws/smithy-go/middleware"
	"github.com/mprync/sendproof/adapters/go/dynamobench"
	"github.com/mprync/sendproof/adapters/go/sendproof"
)

// secretKey is a marker that must never reach a capture.
const secretKey = "benchDynamoSecretMarker"

func endpoint() string {
	if url := os.Getenv("BENCH_DYNAMODB_SERVER_URL"); url != "" {
		return url
	}
	return "http://127.0.0.1:58000"
}

// newClient builds a client against DynamoDB Local, hooked or not.
func newClient(hook bool) *dynamodb.Client {
	options := dynamodb.Options{
		Region: "us-east-1", BaseEndpoint: aws.String(endpoint()), RetryMaxAttempts: 1,
		Credentials: credentials.NewStaticCredentialsProvider("benchlocal", secretKey, ""),
	}
	if hook {
		options.APIOptions = append(options.APIOptions, dynamobench.Middleware())
	}
	return dynamodb.New(options)
}

// needsDynamo creates a fresh table, or skips the test with the compose command.
func needsDynamo(t *testing.T) (plain *dynamodb.Client, table string) {
	t.Helper()
	plain = newClient(false)
	random := make([]byte, 4)
	_, _ = rand.Read(random)
	table = "tb_" + hex.EncodeToString(random)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err := plain.CreateTable(ctx, &dynamodb.CreateTableInput{
		TableName:            aws.String(table),
		AttributeDefinitions: []types.AttributeDefinition{{AttributeName: aws.String("id"), AttributeType: types.ScalarAttributeTypeS}},
		KeySchema:            []types.KeySchemaElement{{AttributeName: aws.String("id"), KeyType: types.KeyTypeHash}},
		BillingMode:          types.BillingModePayPerRequest,
	})
	if err != nil {
		t.Skipf("DynamoDB Local is not reachable (docker compose -f tests/conformance/compose.yml up -d dynamodb): %v", err)
	}
	t.Cleanup(func() {
		_, _ = plain.DeleteTable(context.Background(), &dynamodb.DeleteTableInput{TableName: aws.String(table)})
	})
	return plain, table
}

type app struct {
	handler http.Handler
	plain   *dynamodb.Client
	table   string
}

func newApp(t *testing.T, hook bool) *app {
	t.Helper()
	plain, table := needsDynamo(t)
	client := newClient(hook)
	bench, err := sendproof.New(
		sendproof.WithEnvironment("Development"), sendproof.WithDataStore(dynamobench.Store("orders")),
		sendproof.WithPrincipal(func(*http.Request) (sendproof.Principal, bool) {
			return sendproof.Principal{Subject: "ada", Name: "Ada", Scheme: "cookie"}, true
		}),
	)
	if err != nil {
		t.Fatal(err)
	}
	key := func(r *http.Request) map[string]types.AttributeValue {
		return map[string]types.AttributeValue{"id": &types.AttributeValueMemberS{Value: r.PathValue("id")}}
	}
	reply := func(w http.ResponseWriter, status int, body any) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(body)
	}
	mux := http.NewServeMux()
	bench.HandlePreview(mux, "GET /orders/{id}", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		out, err := client.GetItem(r.Context(), &dynamodb.GetItemInput{TableName: aws.String(table), Key: key(r)})
		if err != nil || out.Item == nil {
			reply(w, 404, map[string]any{"error": "not found"})
			return
		}
		reply(w, 200, map[string]any{"id": r.PathValue("id")})
	}))
	// touch swallows nothing: it reports the SDK error with a 500.
	bench.HandlePreview(mux, "POST /orders/{id}/touch", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		out, err := client.UpdateItem(r.Context(), &dynamodb.UpdateItemInput{
			TableName: aws.String(table), Key: key(r), ReturnValues: types.ReturnValueAllNew,
			UpdateExpression:          aws.String("ADD hits :one SET #s = if_not_exists(#s, :new)"),
			ExpressionAttributeNames:  map[string]string{"#s": "status"},
			ExpressionAttributeValues: map[string]types.AttributeValue{":one": &types.AttributeValueMemberN{Value: "1"}, ":new": &types.AttributeValueMemberS{Value: "new"}},
		})
		if err != nil {
			reply(w, 500, map[string]any{"error": err.Error()})
			return
		}
		reply(w, 200, map[string]any{"attributes": len(out.Attributes)})
	}))
	// cancel inlines a literal in PartiQL, catches the refusal and answers 200.
	bench.HandlePreview(mux, "POST /orders/{id}/cancel", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, err := client.ExecuteStatement(r.Context(), &dynamodb.ExecuteStatementInput{
			Statement:  aws.String(`UPDATE "` + table + `" SET status = 'cancelled' WHERE id = ?`),
			Parameters: []types.AttributeValue{&types.AttributeValueMemberS{Value: r.PathValue("id")}},
		})
		reply(w, 200, map[string]any{"swallowed": err != nil})
	}))
	bench.HandlePreview(mux, "POST /orders/{id}/select", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		out, err := client.ExecuteStatement(r.Context(), &dynamodb.ExecuteStatementInput{
			Statement: aws.String(`/* read */ select * FROM "` + table + `" WHERE id = 'seeded' AND hits > 3`),
		})
		if err != nil {
			reply(w, 500, map[string]any{"error": err.Error()})
			return
		}
		reply(w, 200, map[string]any{"items": len(out.Items)})
	}))
	return &app{handler: bench.Middleware(mux), plain: plain, table: table}
}

func (a *app) do(method, path string, headers map[string]string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(`{}`))
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	response := httptest.NewRecorder()
	a.handler.ServeHTTP(response, request)
	return response
}

func (a *app) preview(method, target string) *httptest.ResponseRecorder {
	return a.do(method, "/sendproof/_preview"+target, map[string]string{"Prefer": "tx=rollback"})
}

func (a *app) item(t *testing.T, id string) map[string]types.AttributeValue {
	t.Helper()
	out, err := a.plain.GetItem(context.Background(), &dynamodb.GetItemInput{
		TableName: aws.String(a.table), Key: map[string]types.AttributeValue{"id": &types.AttributeValueMemberS{Value: id}},
	})
	if err != nil {
		t.Fatal(err)
	}
	return out.Item
}

func (a *app) seed(t *testing.T, id string) {
	t.Helper()
	_, err := a.plain.PutItem(context.Background(), &dynamodb.PutItemInput{
		TableName: aws.String(a.table),
		Item:      map[string]types.AttributeValue{"id": &types.AttributeValueMemberS{Value: id}, "status": &types.AttributeValueMemberS{Value: "open"}},
	})
	if err != nil {
		t.Fatal(err)
	}
}

func assertBlocked(t *testing.T, response *httptest.ResponseRecorder, operation string) {
	t.Helper()
	var body map[string]any
	_ = json.Unmarshal(response.Body.Bytes(), &body)
	if response.Code != 409 || body["code"] != "preview_unavailable" || body["store"] != "dynamodb" || body["operation"] != operation ||
		body["detail"] != "Preview unavailable: this operation writes to DynamoDB" || response.Header().Get("Preference-Applied") != "" {
		t.Fatalf("expected a blocked Preview for %s, got %d %s", operation, response.Code, response.Body)
	}
}

func TestReadsRunAndPartiQLLiteralsAreReplaced(t *testing.T) {
	a := newApp(t, true)
	a.seed(t, "seeded")
	if response := a.preview("GET", "/orders/seeded"); response.Code != 200 || !strings.Contains(response.Body.String(), `"rolledBack":true`) {
		t.Fatalf("a GetItem must be confirmed: %d %s", response.Code, response.Body)
	}
	response := a.preview("POST", "/orders/seeded/select")
	if response.Code != 200 {
		t.Fatalf("a PartiQL SELECT is a read: %d %s", response.Code, response.Body)
	}
	var body struct {
		Logs []struct {
			DB map[string]any `json:"db"`
		} `json:"logs"`
	}
	_ = json.Unmarshal(response.Body.Bytes(), &body)
	if len(body.Logs) != 1 || body.Logs[0].DB["operation"] != "ExecuteStatement" || body.Logs[0].DB["target"] != a.table ||
		body.Logs[0].DB["statement"] != `/* read */ select * FROM "`+a.table+`" WHERE id = ? AND hits > ?` {
		t.Errorf("Db entries must replace inline PartiQL literals with ?: %+v", body.Logs)
	}
}

func TestWritesAreRefusedBeforeTheyAreSent(t *testing.T) {
	a := newApp(t, true)
	a.seed(t, "seeded")
	assertBlocked(t, a.preview("POST", "/orders/blocked/touch"), "UpdateItem")
	if a.item(t, "blocked") != nil {
		t.Error("UpdateItem reached DynamoDB")
	}
	// A PartiQL UPDATE travels through ExecuteStatement, which also carries reads.
	assertBlocked(t, a.preview("POST", "/orders/seeded/cancel"), "ExecuteStatement")
	if status := a.item(t, "seeded")["status"].(*types.AttributeValueMemberS).Value; status != "open" {
		t.Errorf("the PartiQL UPDATE reached DynamoDB: %s", status)
	}
}

func TestTheChecksFailWithoutTheMiddleware(t *testing.T) {
	a := newApp(t, false)
	response := a.preview("POST", "/orders/unguarded/touch")
	if response.Code != 200 || a.item(t, "unguarded") == nil {
		t.Fatalf("an unhooked client should have written: %d", response.Code)
	}
}

func TestObservedSendCommitsOnceAndNeverCapturesCredentials(t *testing.T) {
	a := newApp(t, true)
	response := a.do("POST", "/orders/sent/touch", map[string]string{"Prefer": "trace"})
	id := response.Header().Get("X-Sendproof-Trace")
	if response.Code != 200 || id == "" {
		t.Fatalf("observed send: %d %v", response.Code, response.Header())
	}
	item := a.item(t, "sent")
	if item["hits"].(*types.AttributeValueMemberN).Value != "1" {
		t.Errorf("observed Send must commit exactly once: %v", item)
	}
	trace := a.do("GET", "/sendproof/_api/traces/"+id, nil).Body.String()
	capabilities := a.do("GET", "/sendproof/_api/capabilities", nil).Body.String()
	if !strings.Contains(trace, `"operation":"UpdateItem"`) {
		t.Errorf("the trace has no UpdateItem Db entry: %s", trace)
	}
	for _, text := range []string{trace, capabilities} {
		if strings.Contains(text, secretKey) || strings.Contains(text, "AWS4-HMAC-SHA256") || strings.Contains(text, "127.0.0.1") {
			t.Errorf("a capture leaked credentials or the endpoint: %s", text)
		}
	}
}

func TestAddingTheMiddlewareTwiceIsRefused(t *testing.T) {
	stack := middleware.NewStack("test", func() any { return struct{}{} })
	if err := dynamobench.Middleware()(stack); err != nil {
		t.Fatal(err)
	}
	if err := dynamobench.Middleware()(stack); err == nil {
		t.Error("a second hook on the same stack must be refused")
	}
}
