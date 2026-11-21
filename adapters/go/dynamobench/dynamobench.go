// Package dynamobench guards AWS SDK for Go v2 DynamoDB clients for Sendproof
// Preview (spec/data-stores.md, store mode "guard").
//
// Add the middleware to the client's API options and register the store so
// discovery lists it:
//
//	cfg, _ := config.LoadDefaultConfig(ctx)
//	cfg.APIOptions = append(cfg.APIOptions, dynamobench.Middleware())
//	orders := dynamodb.NewFromConfig(cfg)
//	bench, _ := sendproof.New(sendproof.WithDataStore(dynamobench.Store("orders")))
//
// The middleware runs in the Initialize step, before the request is serialized
// and signed, so a refused command never becomes an HTTP request and the
// credentials, the Authorization header and signatures never reach it. Reads run.
// During a Preview the first write (UpdateItem, PutItem, DeleteItem, a
// transaction or batch write, or a PartiQL statement that is not a SELECT) is
// refused with a *sendproof.PreviewWriteBlockedError and the Preview answers
// HTTP 409, whatever the handler does with the error. Every other command becomes
// a Db log entry; PartiQL text has its literals replaced by ?.
//
// # Coverage
//
// Only clients built with the middleware are covered, and only calls made with
// the request's context: pass r.Context() to every call. A client created
// separately and DynamoDB Streams are not covered. A write sent with
// context.Background() while a Preview is open runs, and fails that Preview with
// 500 (see sendproof.ReportWrite and sendproof.Detached). Marking a route preview: false (HandleUnavailable) saves a round trip.
package dynamobench

import (
	"context"
	"errors"
	"reflect"
	"sort"
	"strings"
	"time"

	awsmiddleware "github.com/aws/aws-sdk-go-v2/aws/middleware"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/smithy-go"
	"github.com/aws/smithy-go/middleware"
	"github.com/mprync/sendproof/adapters/go/sendproof"
	"github.com/mprync/sendproof/adapters/go/stores"
)

const (
	system         = "dynamodb"
	middlewareName = "SendproofWriteGuard"
)

// Option configures Middleware.
type Option func(*settings) error

type settings struct{ reads map[string]bool }

// TreatAsRead declares DynamoDB actions the host states never write, by exact
// action name. A wrongly listed write is not blocked in a Preview.
func TreatAsRead(actions ...string) Option {
	return func(s *settings) error {
		reads, err := stores.ReadSet(actions, nil)
		if err != nil {
			return err
		}
		if s.reads == nil {
			s.reads = map[string]bool{}
		}
		for name := range reads {
			s.reads[name] = true
		}
		return nil
	}
}

// Middleware returns the API option that adds the guard to a DynamoDB client's
// stack. Append it to Config.APIOptions or dynamodb.Options.APIOptions. Adding it
// to the same client twice is refused, so a command is never logged twice. It
// panics when an option is invalid, because that is a startup configuration error.
func Middleware(options ...Option) func(*middleware.Stack) error {
	var config settings
	for _, option := range options {
		if err := option(&config); err != nil {
			panic(err)
		}
	}
	guard := middleware.InitializeMiddlewareFunc(middlewareName,
		func(ctx context.Context, in middleware.InitializeInput, next middleware.InitializeHandler) (middleware.InitializeOutput, middleware.Metadata, error) {
			return handle(ctx, in, next, config.reads)
		})
	return func(stack *middleware.Stack) error {
		if _, hooked := stack.Initialize.Get(middlewareName); hooked {
			return errors.New("dynamobench: the middleware is already on this client's stack")
		}
		// After the SDK's own Initialize middleware, so the operation name is set.
		return stack.Initialize.Add(guard, middleware.After)
	}
}

// Store returns the data store for sendproof.WithDataStore. name is an optional
// display label for discovery, such as "orders": never an endpoint or ARN. It
// panics on a label that looks like connection details.
func Store(name string) sendproof.DataStore {
	label, err := stores.Label(name)
	if err != nil {
		panic(err)
	}
	return &store{name: label}
}

// store is the discovery entry of a hooked client. DynamoDB has no Preview
// transaction, so it prepares nothing per Preview.
type store struct{ name string }

func (s *store) Describe(context.Context) sendproof.DataStoreInfo {
	return sendproof.DataStoreInfo{System: system, Name: s.name, Mode: sendproof.ModeGuard}
}

func (s *store) BeginPreview(context.Context) (sendproof.StorePreview, error) { return nil, nil }

// handle guards one call and logs it.
func handle(ctx context.Context, in middleware.InitializeInput, next middleware.InitializeHandler, reads map[string]bool) (middleware.InitializeOutput, middleware.Metadata, error) {
	operation := awsmiddleware.GetOperationName(ctx)
	if operation == "" {
		operation = strings.TrimSuffix(strings.TrimPrefix(reflect.TypeOf(in.Parameters).String(), "*dynamodb."), "Input")
	}
	statements := partiqlStatements(in.Parameters)
	kind := stores.ClassifyDynamo(operation, statements, reads)
	if err := sendproof.Guard(ctx, system, operation, kind == stores.Write, ""); err != nil {
		return middleware.InitializeOutput{}, middleware.Metadata{}, err
	}
	call := sendproof.DbCall{System: system, Operation: operation, Target: tableOf(in.Parameters), RowsAffected: sendproof.UnknownRows}
	if len(statements) > 0 {
		sanitized := make([]string, len(statements))
		for index, statement := range statements {
			sanitized[index] = stores.SanitizePartiQL(statement)
		}
		call.Statement = strings.Join(sanitized, "; ")
		if call.Target == "" {
			call.Target = quotedTable(sanitized[0])
		}
	}
	started := time.Now()
	out, metadata, err := next.HandleInitialize(ctx, in)
	call.Duration = time.Since(started)
	if err != nil {
		call.Error = errorName(err)
	} else if rows, ok := rowsOf(out.Result); ok {
		call.RowsAffected = rows
	}
	sendproof.RecordDb(ctx, call)
	return out, metadata, err
}

// partiqlStatements returns the PartiQL text of an ExecuteStatement,
// BatchExecuteStatement or ExecuteTransaction request, and nil for every other action.
func partiqlStatements(params any) []string {
	var statements []string
	switch input := params.(type) {
	case *dynamodb.ExecuteStatementInput:
		statements = append(statements, deref(input.Statement))
	case *dynamodb.BatchExecuteStatementInput:
		for _, statement := range input.Statements {
			statements = append(statements, deref(statement.Statement))
		}
	case *dynamodb.ExecuteTransactionInput:
		for _, statement := range input.TransactStatements {
			statements = append(statements, deref(statement.Statement))
		}
	}
	return statements
}

func deref(text *string) string {
	if text == nil {
		return ""
	}
	return *text
}

// tableOf returns the table a request targets: its TableName, or the first table
// of a batch request, in name order.
func tableOf(params any) string {
	value := reflect.ValueOf(params)
	if value.Kind() != reflect.Pointer || value.IsNil() || value.Elem().Kind() != reflect.Struct {
		return ""
	}
	if field := value.Elem().FieldByName("TableName"); field.IsValid() && field.Kind() == reflect.Pointer && !field.IsNil() {
		return field.Elem().String()
	}
	if field := value.Elem().FieldByName("RequestItems"); field.IsValid() && field.Kind() == reflect.Map {
		names := make([]string, 0, field.Len())
		for _, key := range field.MapKeys() {
			names = append(names, key.String())
		}
		sort.Strings(names)
		if len(names) > 0 {
			return names[0]
		}
	}
	return ""
}

// quotedTable returns the first double-quoted name of a PartiQL statement.
func quotedTable(statement string) string {
	start := strings.IndexByte(statement, '"')
	if start < 0 {
		return ""
	}
	end := strings.IndexByte(statement[start+1:], '"')
	if end < 0 {
		return ""
	}
	return statement[start+1 : start+1+end]
}

// rowsOf counts the items a reply carries: Items, Count, Item or Attributes.
func rowsOf(result any) (int64, bool) {
	value := reflect.ValueOf(result)
	if value.Kind() != reflect.Pointer || value.IsNil() || value.Elem().Kind() != reflect.Struct {
		return 0, false
	}
	output := value.Elem()
	if items := output.FieldByName("Items"); items.IsValid() && items.Kind() == reflect.Slice {
		return int64(items.Len()), true
	}
	if count := output.FieldByName("Count"); count.IsValid() && count.CanInt() {
		return count.Int(), true
	}
	for _, name := range []string{"Item", "Attributes"} {
		if field := output.FieldByName(name); field.IsValid() && field.Kind() == reflect.Map && field.Len() > 0 {
			return 1, true
		}
	}
	return 0, false
}

// errorName is the service error code, such as ConditionalCheckFailedException.
func errorName(err error) string {
	var api smithy.APIError
	if errors.As(err, &api) && api.ErrorCode() != "" {
		return api.ErrorCode()
	}
	return "Error"
}
