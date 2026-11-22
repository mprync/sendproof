package firestorebench_test

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"cloud.google.com/go/firestore/apiv1/firestorepb"
	"google.golang.org/grpc"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/reflect/protoregistry"

	"github.com/mprync/sendproof/adapters/go/firestorebench"
	"github.com/mprync/sendproof/adapters/go/sendproof"
)

// recordingsFile holds the Firestore requests recorded from a real SDK
// (spec/data-stores/recordings/README.md). They were recorded on the REST
// transport; the gRPC message is the same proto3 JSON.
const recordingsFile = "../../../spec/data-stores/recordings/firestore.json"

type recordedRequest struct {
	REST struct {
		Body json.RawMessage `json:"body"`
	} `json:"rest"`
	RPC    string `json:"rpc"`
	Expect struct{ Kind, Operation string }
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

// method looks up a Firestore RPC in the generated service descriptor, so the
// replay builds the right request type and knows whether the call streams.
func method(t *testing.T, rpc string) protoreflect.MethodDescriptor {
	t.Helper()
	service := firestorepb.File_google_firestore_v1_firestore_proto.Services().ByName("Firestore")
	found := service.Methods().ByName(protoreflect.Name(rpc[strings.LastIndex(rpc, "/")+1:]))
	if found == nil {
		t.Fatalf("unknown RPC %s", rpc)
	}
	return found
}

// message parses the recorded REST body, the proto3 JSON of the gRPC request, into its message type.
func message(t *testing.T, descriptor protoreflect.MethodDescriptor, body json.RawMessage) proto.Message {
	t.Helper()
	request := dynamicNew(descriptor)
	if len(body) > 0 {
		if err := (protojson.UnmarshalOptions{DiscardUnknown: true}).Unmarshal(body, request); err != nil {
			t.Fatal(err)
		}
	}
	return request
}

// fakeStream is a client stream whose server answers nothing and ends.
type fakeStream struct{ grpc.ClientStream }

func (fakeStream) SendMsg(any) error { return nil }
func (fakeStream) RecvMsg(any) error { return io.EOF }
func (fakeStream) CloseSend() error  { return nil }

// sent records which methods reached the fake connection.
type sent struct{ methods []string }

// replayAll runs every request of a recording through the guard's interceptors
// the way the gRPC client would, inside r's context, and returns each call's error.
func replayAll(t *testing.T, r *http.Request, recorded recording, guarded bool, reached *sent) []error {
	t.Helper()
	unary, stream := firestorebench.UnaryInterceptor(), firestorebench.StreamInterceptor()
	var errs []error
	for _, request := range recorded.Requests {
		descriptor := method(t, request.RPC)
		full := "/" + string(descriptor.Parent().FullName()) + "/" + string(descriptor.Name())
		msg := message(t, descriptor, request.REST.Body)
		var err error
		if descriptor.IsStreamingClient() || descriptor.IsStreamingServer() {
			streamer := func(ctx context.Context, desc *grpc.StreamDesc, conn *grpc.ClientConn, method string, opts ...grpc.CallOption) (grpc.ClientStream, error) {
				reached.methods = append(reached.methods, method)
				return fakeStream{}, nil
			}
			var opened grpc.ClientStream
			if guarded {
				opened, err = stream(r.Context(), &grpc.StreamDesc{}, nil, full, streamer)
			} else {
				opened, err = streamer(r.Context(), &grpc.StreamDesc{}, nil, full)
			}
			if err == nil {
				// The first message and the end of the stream, as a server-streaming call does.
				_ = opened.SendMsg(msg)
				_ = opened.RecvMsg(nil)
			}
		} else {
			invoker := func(ctx context.Context, method string, req, reply any, conn *grpc.ClientConn, opts ...grpc.CallOption) error {
				reached.methods = append(reached.methods, method)
				return nil
			}
			if guarded {
				err = unary(r.Context(), full, msg, nil, nil, invoker)
			} else {
				err = invoker(r.Context(), full, msg, nil, nil)
			}
		}
		errs = append(errs, err)
	}
	return errs
}

type replayResult struct {
	status   int
	response map[string]any
	reached  sent
	errors   []error
}

func replay(t *testing.T, recorded recording, guarded, preview bool) replayResult {
	t.Helper()
	bench, err := sendproof.New(sendproof.WithEnvironment("Development"), sendproof.WithDataStore(firestorebench.Store("orders")),
		sendproof.WithPrincipal(func(*http.Request) (sendproof.Principal, bool) {
			return sendproof.Principal{Subject: "ada", Scheme: "cookie"}, true
		}))
	if err != nil {
		t.Fatal(err)
	}
	var result replayResult
	mux := http.NewServeMux()
	bench.HandlePreview(mux, "POST /replay", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		result.errors = replayAll(t, r, recorded, guarded, &result.reached)
		_, _ = w.Write([]byte(`{}`))
	}))
	target := "/replay"
	if preview {
		target = "/sendproof/_preview/replay"
	}
	request := httptest.NewRequest("POST", target, strings.NewReader(`{}`))
	if preview {
		request.Header.Set("Prefer", "tx=rollback")
	}
	response := httptest.NewRecorder()
	bench.Middleware(mux).ServeHTTP(response, request)
	result.status = response.Code
	_ = json.Unmarshal(response.Body.Bytes(), &result.response)
	return result
}

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

func firstWrite(recorded recording) string {
	for _, request := range recorded.Requests {
		if request.Expect.Kind == "write" {
			return request.Expect.Operation
		}
	}
	return ""
}

// TestRecordedRequestsAreClassifiedLikeTheSDKSentThem replays every recording as
// gRPC calls: reads and session calls reach the connection, writes are refused
// before it, the Preview answers 409, and reads are logged without their values.
func TestRecordedRequestsAreClassifiedLikeTheSDKSentThem(t *testing.T) {
	for _, recorded := range loadRecordings(t) {
		t.Run(recorded.Name, func(t *testing.T) {
			result := replay(t, recorded, true, true)
			var wantReached, wantLogged []string
			for index, request := range recorded.Requests {
				if request.Expect.Kind == "write" {
					var blocked *sendproof.PreviewWriteBlockedError
					if err := result.errors[index]; !errors.As(err, &blocked) || blocked.Store != "firestore" || blocked.Operation != request.Expect.Operation {
						t.Errorf("request %d (%s) must be refused as %s, got %v", index, request.RPC, request.Expect.Operation, err)
					}
					continue
				}
				if result.errors[index] != nil {
					t.Errorf("request %d (%s) must run: %v", index, request.RPC, result.errors[index])
				}
				wantReached = append(wantReached, "/google.firestore.v1.Firestore/"+request.Expect.Operation)
				if request.Expect.Kind == "read" {
					wantLogged = append(wantLogged, request.Expect.Operation)
				}
			}
			if strings.Join(result.reached.methods, ",") != strings.Join(wantReached, ",") {
				t.Errorf("reached the connection: %v, want %v", result.reached.methods, wantReached)
			}
			if write := firstWrite(recorded); write != "" {
				if result.status != 409 || result.response["code"] != "preview_unavailable" || result.response["store"] != "firestore" || result.response["operation"] != write {
					t.Errorf("a recording with a write must answer 409 for %s: %d %v", write, result.status, result.response)
				}
			} else if result.status != 200 || result.response["rolledBack"] != true {
				t.Errorf("a recording of reads must be confirmed: %d %v", result.status, result.response)
			}
			// A blocked Preview answers with the problem body alone, so only a recording
			// of reads shows its Db entries.
			if firstWrite(recorded) == "" {
				if got := dbOperations(result.response); strings.Join(got, ",") != strings.Join(wantLogged, ",") {
					t.Errorf("Db entries %v, want %v", got, wantLogged)
				}
			}
			if text, _ := json.Marshal(result.response); strings.Contains(string(text), `"open"`) || strings.Contains(string(text), "o-1") {
				t.Errorf("a value or document path reached the capture: %s", text)
			}
		})
	}
}

func TestRecordedRequestsAreAllSentOutsideAPreview(t *testing.T) {
	for _, recorded := range loadRecordings(t) {
		result := replay(t, recorded, true, false)
		if len(result.reached.methods) != len(recorded.Requests) {
			t.Errorf("%s: outside a Preview every call is sent: %d of %d", recorded.Name, len(result.reached.methods), len(recorded.Requests))
		}
		for _, err := range result.errors {
			if err != nil {
				t.Errorf("%s: %v", recorded.Name, err)
			}
		}
	}
}

// TestTheReplayFailsWithTheHookRemoved is the negative test: with no interceptor
// the writes reach the connection and no Preview is blocked.
func TestTheReplayFailsWithTheHookRemoved(t *testing.T) {
	writes := 0
	for _, recorded := range loadRecordings(t) {
		if firstWrite(recorded) == "" {
			continue
		}
		writes++
		result := replay(t, recorded, false, true)
		if result.status == 409 || len(result.reached.methods) != len(recorded.Requests) {
			t.Errorf("%s: without the hook nothing should be refused", recorded.Name)
		}
	}
	if writes == 0 {
		t.Fatal("no recording has a write")
	}
}

// dynamicNew builds an empty request message for a method, from the global registry.
func dynamicNew(descriptor protoreflect.MethodDescriptor) proto.Message {
	messageType, err := protoregistry.GlobalTypes.FindMessageByName(descriptor.Input().FullName())
	if err != nil {
		panic(err)
	}
	return messageType.New().Interface()
}
