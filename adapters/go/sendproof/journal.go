package sendproof

import (
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"
)

// previewEffect is one recorded side effect in the wire format of the preview schema.
type previewEffect struct {
	Kind        string          `json:"kind"`
	Description string          `json:"description"`
	Data        json.RawMessage `json:"data"`
	Delivered   *bool           `json:"delivered,omitempty"`
}

type logEventID struct {
	ID   int    `json:"id"`
	Name string `json:"name,omitempty"`
}

type logException struct {
	Type    string `json:"type"`
	Message string `json:"message"`
}

type sqlParameter struct {
	Name   string  `json:"name"`
	Value  *string `json:"value"`
	DBType string  `json:"dbType"`
}

type sqlEntry struct {
	Text         string         `json:"text"`
	Parameters   []sqlParameter `json:"parameters"`
	RowsAffected *int64         `json:"rowsAffected,omitempty"`
}

// previewLog is one structured log entry in the wire format of the preview schema.
type previewLog struct {
	Level     string            `json:"level"`
	Message   string            `json:"message"`
	Category  string            `json:"category,omitempty"`
	EventID   *logEventID       `json:"eventId,omitempty"`
	OffsetMs  *float64          `json:"offsetMs,omitempty"`
	ElapsedMs *float64          `json:"elapsedMs,omitempty"`
	Props     map[string]string `json:"properties,omitempty"`
	Exception *logException     `json:"exception,omitempty"`
	SQL       *sqlEntry         `json:"sql,omitempty"`
	DB        *dbEntry          `json:"db,omitempty"`
}

// size approximates the retained text so one request cannot hold unbounded memory.
func (l previewLog) size() int {
	total := len(l.Level) + len(l.Message) + len(l.Category)
	if l.EventID != nil {
		total += len(l.EventID.Name)
	}
	for key, value := range l.Props {
		total += len(key) + len(value)
	}
	if l.Exception != nil {
		total += len(l.Exception.Type) + len(l.Exception.Message)
	}
	if l.DB != nil {
		total += len(l.DB.System) + len(l.DB.Namespace) + len(l.DB.Operation) + len(l.DB.Target) + len(l.DB.Statement) + len(l.DB.Error)
	}
	if l.SQL != nil {
		total += len(l.SQL.Text)
		for _, parameter := range l.SQL.Parameters {
			total += len(parameter.Name) + len(parameter.DBType)
			if parameter.Value != nil {
				total += len(*parameter.Value)
			}
		}
	}
	return total
}

// captureTiming is the final timing breakdown of an observed request or preview.
type captureTiming struct {
	Auth       float64 `json:"auth"`
	Handler    float64 `json:"handler"`
	DB         float64 `json:"db"`
	QueryCount int     `json:"queryCount"`
	Serialize  float64 `json:"serialize"`
}

// header renders the timing as a Server-Timing value.
func (t captureTiming) header() string {
	return fmt.Sprintf(`auth;dur=%.3f, handler;dur=%.3f, db;dur=%.3f;desc="%d queries", serialize;dur=%.3f`,
		t.Auth, t.Handler, t.DB, t.QueryCount, t.Serialize)
}

// captureSnapshot is the immutable result of closing a recorder.
type captureSnapshot struct {
	Effects          []previewEffect
	Logs             []previewLog
	LogsTruncated    bool
	EffectsTruncated bool
}

// recorder is the per-request journal of effects, logs and timings. It only
// collects while active, so code that runs outside Sendproof pays nothing.
type recorder struct {
	mu               sync.Mutex
	bench            *Sendproof
	active           bool
	rollback         bool
	effects          []previewEffect
	logs             []previewLog
	logsTruncated    bool
	effectsTruncated bool
	logSize          int
	effectSize       int
	start            time.Time
	handlerStart     time.Time
	handlerEnd       time.Time
	dbMs             float64
	queries          int
	serializeMs      float64
}

func newRecorder(bench *Sendproof, start time.Time) *recorder {
	return &recorder{bench: bench, start: start}
}

// begin starts collecting. A rollback recorder is a preview; otherwise it is an
// observed send whose effects are delivered.
func (r *recorder) begin(rollback bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.active, r.rollback = true, rollback
	r.handlerStart = time.Now()
}

func (r *recorder) isPreview() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.active && r.rollback
}

func (r *recorder) isActive() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.active
}

func (r *recorder) offsetMs() float64 {
	return float64(time.Since(r.start)) / float64(time.Millisecond)
}

// recordEffect stores one effect and reports whether the host should suppress it.
func (r *recorder) recordEffect(kind, description string, data any) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.active {
		return false
	}
	if len(r.effects) == MaxEffects || r.effectSize >= logBudget {
		r.effectsTruncated = true
		return r.rollback
	}
	started := time.Now()
	var captured json.RawMessage
	dataOK := true
	if data != nil {
		captured, dataOK = snapshotJSON(data)
	}
	r.serializeMs += float64(time.Since(started)) / float64(time.Millisecond)
	capturedKind, capturedDescription := clip(kind, maxName), clip(description, maxText)
	r.effectSize += len(capturedKind) + len(capturedDescription) + len(captured)
	r.effectsTruncated = r.effectsTruncated || capturedKind != kind || capturedDescription != description || !dataOK
	if r.effectSize > logBudget {
		r.effectsTruncated = true
		return r.rollback
	}
	effect := previewEffect{Kind: capturedKind, Description: capturedDescription, Data: captured}
	if captured == nil {
		effect.Data = json.RawMessage("null")
	}
	if !r.rollback {
		delivered := true
		effect.Delivered = &delivered
	}
	r.effects = append(r.effects, effect)
	return r.rollback
}

func (r *recorder) hasLogRoom() bool {
	room := len(r.logs) < MaxLogs && r.logSize < logBudget
	if !room {
		r.logsTruncated = true
	}
	return room
}

func (r *recorder) clipLog(value string, maximum int) string {
	result := clip(value, maximum)
	if len(result) != len(value) {
		r.logsTruncated = true
	}
	return result
}

func (r *recorder) addLog(entry previewLog) {
	if !r.hasLogRoom() {
		return
	}
	if size := entry.size(); r.logSize+size <= logBudget {
		r.logs = append(r.logs, entry)
		r.logSize += size
	} else {
		r.logsTruncated = true
	}
}

// recordLog adds a plain log entry and reports whether capture is active.
func (r *recorder) recordLog(level, message string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.active {
		return false
	}
	if r.hasLogRoom() {
		offset := r.offsetMs()
		r.addLog(previewLog{Level: r.clipLog(level, maxName), Message: r.clipLog(message, maxText), OffsetMs: &offset})
	}
	return true
}

// recordStructured adds a log entry with a category and properties, as produced
// by the slog handler.
func (r *recorder) recordStructured(level, category, message string, props map[string]string, failure error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.active || !r.hasLogRoom() {
		return
	}
	offset := r.offsetMs()
	entry := previewLog{Level: level, Message: r.clipLog(message, maxText), OffsetMs: &offset}
	if category != "" {
		entry.Category = r.clipLog(category, maxName)
	}
	if len(props) > 0 {
		entry.Props = make(map[string]string, len(props))
		for key, value := range props {
			if len(entry.Props) == MaxProperties {
				r.logsTruncated = true
				break
			}
			entry.Props[r.clipLog(key, maxName)] = r.clipLog(value, maxText)
		}
	}
	if failure != nil {
		entry.Exception = &logException{Type: r.clipLog(fmt.Sprintf("%T", failure), maxName), Message: r.clipLog(failure.Error(), maxText)}
	}
	r.addLog(entry)
}

// recordSQL stores one executed command. Redaction happens here so every provider
// shares the same scoped rules.
func (r *recorder) recordSQL(call SQLCall) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.active {
		return
	}
	duration := float64(call.Duration) / float64(time.Millisecond)
	r.dbMs += duration
	if r.queries < int(^uint(0)>>1) {
		r.queries++
	}
	if !r.hasLogRoom() {
		return
	}
	entry, truncated := r.sqlEntry(call)
	r.logsTruncated = r.logsTruncated || truncated
	offset := r.offsetMs() - duration
	if offset < 0 {
		offset = 0
	}
	category := call.Category
	if category == "" {
		category = "database/sql"
	}
	log := previewLog{Level: "Sql", Message: entry.Text, Category: category, OffsetMs: &offset, ElapsedMs: &duration, SQL: &entry}
	if call.Err != nil {
		log.Exception = &logException{Type: clip(fmt.Sprintf("%T", call.Err), maxName), Message: clip(call.Err.Error(), maxText)}
	}
	r.addLog(log)
}

// sqlEntry converts a command into its captured form, redacting parameter values
// according to the bench configuration and secret-looking names.
func (r *recorder) sqlEntry(call SQLCall) (sqlEntry, bool) {
	text := clip(call.Text, maxText)
	truncated := len(text) != len(call.Text) || len(call.Args) > MaxParameters
	showValues := r.bench.includeSQLValues()

	// Generated placeholders such as $1 carry no column information. If the
	// statement refers to a secret-looking name, hide every value in it, because
	// inferring bindings from fragments of SQL is unsafe.
	redactStatement := showValues && IsSecretName(call.Text)
	parameters := make([]sqlParameter, 0, min(len(call.Args), MaxParameters))
	for index, arg := range call.Args {
		if index == MaxParameters {
			break
		}
		name := arg.Name
		if name == "" {
			name = fmt.Sprintf("$%d", index+1)
		}
		capped := clip(name, maxName)
		truncated = truncated || capped != name
		var value *string
		if !showValues || redactStatement || IsSecretName(name) {
			redacted := redactedValue
			value = &redacted
		} else {
			value = parameterValue(arg.Value, &truncated)
		}
		parameters = append(parameters, sqlParameter{Name: capped, Value: value, DBType: dbTypeName(arg.Value)})
	}
	entry := sqlEntry{Text: text, Parameters: parameters}
	if call.RowsAffected >= 0 && call.Err == nil {
		rows := call.RowsAffected
		entry.RowsAffected = &rows
	}
	return entry, truncated
}

func parameterValue(value any, truncated *bool) *string {
	switch typed := value.(type) {
	case nil:
		return nil
	case []byte:
		length := min(len(typed), maxText/2)
		*truncated = *truncated || length < len(typed)
		text := fmt.Sprintf("%X", typed[:length])
		return &text
	case time.Time:
		text := typed.Format(time.RFC3339Nano)
		return &text
	}
	original := fmt.Sprint(value)
	clipped := clip(original, maxText)
	*truncated = *truncated || clipped != original
	return &clipped
}

// dbTypeName maps a Go argument to a database type label for display.
func dbTypeName(value any) string {
	switch value.(type) {
	case nil:
		return "Object"
	case string:
		return "String"
	case bool:
		return "Boolean"
	case int, int8, int16, int32:
		return "Int32"
	case int64:
		return "Int64"
	case uint, uint8, uint16, uint32, uint64:
		return "UInt64"
	case float32, float64:
		return "Double"
	case []byte:
		return "Binary"
	case time.Time:
		return "DateTime"
	default:
		return strings.TrimPrefix(fmt.Sprintf("%T", value), "*")
	}
}

func (r *recorder) timing(extraSerializeMs float64) captureTiming {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.timingLocked(extraSerializeMs)
}

func (r *recorder) timingLocked(extraSerializeMs float64) captureTiming {
	handlerStart := r.handlerStart
	if handlerStart.IsZero() {
		handlerStart = r.start
	}
	handlerEnd := r.handlerEnd
	if handlerEnd.IsZero() {
		handlerEnd = time.Now()
	}
	ms := func(d time.Duration) float64 { return float64(d) / float64(time.Millisecond) }
	handler := ms(handlerEnd.Sub(handlerStart)) - r.dbMs - r.serializeMs
	if handler < 0 {
		handler = 0
	}
	return captureTiming{
		Auth: ms(handlerStart.Sub(r.start)), Handler: handler, DB: r.dbMs,
		QueryCount: r.queries, Serialize: r.serializeMs + extraSerializeMs,
	}
}

// endHandler freezes the handler time so later serialization is not counted in it.
func (r *recorder) endHandler() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.handlerEnd = time.Now()
}

// finish stops collecting and returns what was captured.
func (r *recorder) finish() captureSnapshot {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.active = false
	snapshot := captureSnapshot{
		Effects: append([]previewEffect{}, r.effects...), Logs: append([]previewLog{}, r.logs...),
		LogsTruncated: r.logsTruncated, EffectsTruncated: r.effectsTruncated,
	}
	r.effects, r.logs = nil, nil
	return snapshot
}
