package cosmosbench_test

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore/policy"
	"github.com/Azure/azure-sdk-for-go/sdk/azcore/runtime"
	"github.com/Azure/azure-sdk-for-go/sdk/azcore/streaming"

	"github.com/mprync/sendproof/adapters/go/cosmosbench"
	"github.com/mprync/sendproof/adapters/go/sendproof"
)

// recordingsFile holds the Cosmos DB requests recorded from a real SDK
// (spec/data-stores/recordings/README.md).
const recordingsFile = "../../../spec/data-stores/recordings/cosmosdb.json"

type recordedRequest struct {
	HTTP struct {
		Method  string            `json:"method"`
		Path    string            `json:"path"`
		Headers map[string]string `json:"headers"`
		Body    json.RawMessage   `json:"body"`
	} `json:"http"`
	Expect struct {
		HTTP struct{ Kind, Operation string } `json:"http"`
	} `json:"expect"`
}

type recording struct {
	Name     string            `json:"name"`
	Requests []recordedRequest `json:"requests"`
}

func loadRecordings(t *testing.T) []recording {
	t.Helper()
	data, err := os.ReadFile(recordingsFile)
	if err != nil {
		t.Skipf("the recordings are not available beside this module: %v", err)
	}
	var file struct {
		Recordings []recording `json:"recordings"`
	}
	if err := json.Unmarshal(data, &file); err != nil {
		t.Fatal(err)
	}
	if len(file.Recordings) == 0 {
		t.Fatal("no recordings")
	}
	return file.Recordings
}

// wire is a fake transport that records what reaches it.
type wire struct{ received []string }

func (w *wire) Do(req *http.Request) (*http.Response, error) {
	w.received = append(w.received, req.Method+" "+req.URL.Path)
	return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{}`)), Request: req}, nil
}

// send replays one recorded request through a pipeline that has the guard (or not).
func send(t *testing.T, pipeline runtime.Pipeline, r *http.Request, recorded recordedRequest) error {
	t.Helper()
	req, err := runtime.NewRequest(r.Context(), recorded.HTTP.Method, "https://cosmos.test"+recorded.HTTP.Path)
	if err != nil {
		t.Fatal(err)
	}
	for name, value := range recorded.HTTP.Headers {
		req.Raw().Header.Set(name, value)
	}
	if len(recorded.HTTP.Body) > 0 {
		if err := req.SetBody(streaming.NopCloser(bytes.NewReader(recorded.HTTP.Body)), "application/json"); err != nil {
			t.Fatal(err)
		}
	}
	response, err := pipeline.Do(req)
	if response != nil && response.Body != nil {
		_ = response.Body.Close()
	}
	return err
}

func newPipeline(guarded bool, transport policy.Transporter) runtime.Pipeline {
	var perCall []policy.Policy
	if guarded {
		perCall = append(perCall, cosmosbench.Policy())
	}
	return runtime.NewPipeline("recordings", "v0", runtime.PipelineOptions{PerCall: perCall}, &policy.ClientOptions{Transport: transport})
}

// replay runs every recorded request of one recording inside a Preview (or
// outside one, when preview is false) and reports what happened.
type replayResult struct {
	status   int
	response map[string]any
	received []string
	errors   []error
}

func replay(t *testing.T, recorded recording, guarded, preview bool) replayResult {
	t.Helper()
	bench, err := sendproof.New(sendproof.WithEnvironment("Development"), sendproof.WithDataStore(cosmosbench.Store("orders")),
		sendproof.WithPrincipal(func(*http.Request) (sendproof.Principal, bool) {
			return sendproof.Principal{Subject: "ada", Scheme: "cookie"}, true
		}))
	if err != nil {
		t.Fatal(err)
	}
	transport := &wire{}
	pipeline := newPipeline(guarded, transport)
	var result replayResult
	mux := http.NewServeMux()
	bench.HandlePreview(mux, "POST /replay", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		for _, request := range recorded.Requests {
			result.errors = append(result.errors, send(t, pipeline, r, request))
		}
		_, _ = w.Write([]byte(`{}`))
	}))
	target := "/replay"
	headers := map[string]string{}
	if preview {
		target = "/sendproof/_preview/replay"
		headers["Prefer"] = "tx=rollback"
	}
	request := httptest.NewRequest("POST", target, strings.NewReader(`{}`))
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	response := httptest.NewRecorder()
	bench.Middleware(mux).ServeHTTP(response, request)
	result.status = response.Code
	_ = json.Unmarshal(response.Body.Bytes(), &result.response)
	result.received = transport.received
	return result
}

// dbOperations lists the operations of the Db entries of a Preview response.
func dbOperations(response map[string]any) []string {
	var operations []string
	logs, _ := response["logs"].([]any)
	for _, entry := range logs {
		if db, _ := entry.(map[string]any)["db"].(map[string]any); db != nil && db["blocked"] != true {
			operations = append(operations, db["operation"].(string))
		}
	}
	return operations
}

func expectedWrites(recorded recording) (reads []string, writes []string) {
	for _, request := range recorded.Requests {
		if request.Expect.HTTP.Kind == "write" {
			writes = append(writes, request.Expect.HTTP.Operation)
		} else {
			reads = append(reads, request.Expect.HTTP.Operation)
		}
	}
	return reads, writes
}

// TestRecordedRequestsAreClassifiedLikeTheSDKSentThem replays every recording
// through the guard: reads reach the transport and are logged, writes are refused
// before the transport, the Preview answers 409, and outside a Preview everything is sent.
func TestRecordedRequestsAreClassifiedLikeTheSDKSentThem(t *testing.T) {
	for _, recorded := range loadRecordings(t) {
		t.Run(recorded.Name, func(t *testing.T) {
			reads, writes := expectedWrites(recorded)
			result := replay(t, recorded, true, true)
			// Every read that reaches the transport does so in order; nothing else does.
			if len(result.received) != len(reads) {
				t.Errorf("transport got %d requests, want the %d reads: %v", len(result.received), len(reads), result.received)
			}
			for index, request := range recorded.Requests {
				if request.Expect.HTTP.Kind == "write" {
					var blocked *sendproof.PreviewWriteBlockedError
					if err := result.errors[index]; !asBlocked(err, &blocked) || blocked.Store != "cosmosdb" || blocked.Operation != request.Expect.HTTP.Operation {
						t.Errorf("request %d (%s) must be refused as %s, got %v", index, request.HTTP.Method+" "+request.HTTP.Path, request.Expect.HTTP.Operation, err)
					}
				} else if result.errors[index] != nil {
					t.Errorf("request %d (%s) is a read and must run: %v", index, request.HTTP.Path, result.errors[index])
				}
			}
			if len(writes) > 0 {
				if result.status != 409 || result.response["code"] != "preview_unavailable" || result.response["store"] != "cosmosdb" || result.response["operation"] != writes[0] {
					t.Errorf("a recording with a write must answer 409 for %s: %d %v", writes[0], result.status, result.response)
				}
				return
			}
			if result.status != 200 || result.response["rolledBack"] != true {
				t.Errorf("a recording of reads must be confirmed: %d %v", result.status, result.response)
			}
			got := dbOperations(result.response)
			if strings.Join(got, ",") != strings.Join(reads, ",") {
				t.Errorf("Db entries %v, want %v", got, reads)
			}
		})
	}
}

func TestRecordedRequestsAreAllSentOutsideAPreview(t *testing.T) {
	for _, recorded := range loadRecordings(t) {
		result := replay(t, recorded, true, false)
		if len(result.received) != len(recorded.Requests) {
			t.Errorf("%s: outside a Preview every request is sent: got %d of %d", recorded.Name, len(result.received), len(recorded.Requests))
		}
		for _, err := range result.errors {
			if err != nil {
				t.Errorf("%s: %v", recorded.Name, err)
			}
		}
	}
}

// TestTheReplayFailsWithTheHookRemoved is the negative test: without the policy
// the writes reach the transport and the Preview is not blocked.
func TestTheReplayFailsWithTheHookRemoved(t *testing.T) {
	failed := 0
	for _, recorded := range loadRecordings(t) {
		_, writes := expectedWrites(recorded)
		if len(writes) == 0 {
			continue
		}
		result := replay(t, recorded, false, true)
		if result.status == 409 || len(result.received) != len(recorded.Requests) {
			t.Errorf("%s: without the hook nothing should be refused", recorded.Name)
		}
		failed++
	}
	if failed == 0 {
		t.Fatal("no recording has a write")
	}
}

func TestAQueryStatementKeepsItsTextWithoutValues(t *testing.T) {
	for _, recorded := range loadRecordings(t) {
		if recorded.Name != "query documents" {
			continue
		}
		result := replay(t, recorded, true, true)
		logs, _ := result.response["logs"].([]any)
		for _, entry := range logs {
			db, _ := entry.(map[string]any)["db"].(map[string]any)
			if db != nil && db["operation"] == "Query" {
				if db["statement"] != "SELECT * FROM c WHERE c.status = @status" {
					t.Errorf("statement: %v", db["statement"])
				}
				if text, _ := json.Marshal(result.response); strings.Contains(string(text), `"open"`) {
					t.Error("a parameter value reached the capture")
				}
				return
			}
		}
		t.Fatalf("no Query entry: %v", logs)
	}
}

// asBlocked reports whether err is the guard's refusal, and returns it in blocked.
func asBlocked(err error, blocked **sendproof.PreviewWriteBlockedError) bool {
	return errors.As(err, blocked)
}
