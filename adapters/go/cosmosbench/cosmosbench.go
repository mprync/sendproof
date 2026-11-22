// Package cosmosbench guards Azure Cosmos DB for NoSQL clients of the azcosmos
// SDK for Sendproof Preview (spec/data-stores.md, store mode "guard").
//
// azcosmos is built on azcore, whose client options take policies that run on the
// HTTP pipeline before a request is sent. The guard is such a policy:
//
//	client, _ := azcosmos.NewClientFromConnectionString(connection, cosmosbench.ClientOptions(nil))
//	// or, with your own options: opts.PerCallPolicies = append(opts.PerCallPolicies, cosmosbench.Policy())
//	bench, _ := sendproof.New(sendproof.WithDataStore(cosmosbench.Store("orders")))
//
// The policy sees every request of the client, including those of the databases,
// containers and items derived from it (they share the client's pipeline), and
// derives the operation from the method, the resource path and the SDK's headers
// with the rules in spec/data-stores/cosmosdb.json: Read, ReadFeed, Query and
// QueryPlan are reads; Create, Upsert, Replace, Patch, Delete, Batch and stored
// procedure Execute are writes, and so is any request that names a trigger.
// Reads run normally. During a Preview the first write is refused before it is
// sent, with a *sendproof.PreviewWriteBlockedError, and the Preview answers HTTP
// 409 whatever the handler does with the error. Every other request becomes a Db
// log entry; a query's statement keeps its text with inline literals replaced by ?,
// and parameter values, documents and the authorization header are never captured.
//
// # Coverage
//
// Only clients built with the policy are covered, and only calls made with the
// request's context: pass r.Context() (or a context derived from it) to every
// call. A client built without the policy, a second client for the same account and
// a call made with context.Background() are not guarded; the last one, while a Preview
// is open, is refused before it is sent and blocks every open Preview, like a
// client's own background goroutine (mark background work with sendproof.Detached).
//
// The policy is public azcore API, so it does not depend on azcosmos internals.
package cosmosbench

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore/policy"
	"github.com/Azure/azure-sdk-for-go/sdk/data/azcosmos"

	"github.com/mprync/sendproof/adapters/go/sendproof"
	"github.com/mprync/sendproof/adapters/go/stores"
)

// system is the store id of Cosmos DB in discovery and Db entries.
const system = "cosmosdb"

// maxBody is the largest query body the guard reads for the Db entry.
const maxBody = 1 << 20

// Store returns the data store for sendproof.WithDataStore. name is an optional
// display label for discovery, such as "orders": never an account URL, host name
// or key. It panics on a label that looks like connection details.
func Store(name string) sendproof.DataStore {
	label, err := stores.Label(name)
	if err != nil {
		panic(err)
	}
	return &store{name: label}
}

// store is the discovery entry of a guarded client. Cosmos DB cannot roll back an
// arbitrary handler's writes, so it prepares nothing per Preview.
type store struct{ name string }

func (s *store) Describe(context.Context) sendproof.DataStoreInfo {
	return sendproof.DataStoreInfo{System: system, Name: s.name, Mode: sendproof.ModeGuard}
}

func (s *store) BeginPreview(context.Context) (sendproof.StorePreview, error) { return nil, nil }

// Policy returns the azcore policy that guards and logs the client's requests. Add
// it to ClientOptions.PerCallPolicies, or use ClientOptions.
func Policy() policy.Policy { return guard{} }

// ClientOptions returns a copy of base (nil for none) whose PerCallPolicies end with
// the guard, for azcosmos.NewClient, NewClientWithKey and
// NewClientFromConnectionString. The caller's options are not changed.
func ClientOptions(base *azcosmos.ClientOptions) *azcosmos.ClientOptions {
	var options azcosmos.ClientOptions
	if base != nil {
		options = *base
	}
	options.PerCallPolicies = append(append([]policy.Policy{}, options.PerCallPolicies...), Policy())
	return &options
}

// guard is the pipeline policy.
type guard struct{}

// Do classifies the request before it is sent. A refused write is returned as an
// error and nothing reaches the transport.
func (guard) Do(req *policy.Request) (*http.Response, error) {
	raw := req.Raw()
	ctx := raw.Context()
	headers := func(name string) string { return raw.Header.Get(name) }
	decision := stores.DeriveCosmosOperation(raw.Method, raw.URL.Path, headers)
	if err := sendproof.Guard(ctx, system, decision.Operation, decision.Kind == stores.Write, ""); err != nil {
		return nil, err
	}
	statement := queryText(req, decision)
	started := time.Now()
	resp, err := req.Next()
	record(ctx, decision, raw, statement, started, resp, err)
	return resp, err
}

// queryText reads the SQL text of a Query or QueryPlan request body, with inline
// literals replaced by ?. The body is rewound for sending. Parameters are never read.
func queryText(req *policy.Request, decision stores.Decision) string {
	if decision.Operation != "Query" && decision.Operation != "QueryPlan" || req.Body() == nil {
		return ""
	}
	body, err := io.ReadAll(io.LimitReader(req.Body(), maxBody+1))
	if rewind := req.RewindBody(); rewind != nil || err != nil || len(body) > maxBody {
		return ""
	}
	var query struct {
		Query string `json:"query"`
	}
	if json.NewDecoder(bytes.NewReader(body)).Decode(&query) != nil {
		return ""
	}
	return stores.SanitizeLiterals(query.Query, true)
}

// record logs the request as a Db entry.
func record(ctx context.Context, decision stores.Decision, raw *http.Request, statement string, started time.Time, resp *http.Response, failure error) {
	database, container := stores.CosmosTarget(raw.URL.Path)
	call := sendproof.DbCall{
		System: system, Operation: decision.Operation, Target: container, Namespace: database,
		Statement: statement, RowsAffected: sendproof.UnknownRows, Duration: time.Since(started),
	}
	switch {
	case failure != nil:
		call.Error = "Error"
	case resp != nil && resp.StatusCode >= 400:
		call.Error = strconv.Itoa(resp.StatusCode)
	}
	sendproof.RecordDb(ctx, call)
}
