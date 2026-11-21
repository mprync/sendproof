package sendproof

import (
	"bytes"
	"encoding/json"
	"unicode/utf8"
)

// Capture limits shared by every Sendproof adapter. They keep a runaway handler
// from exhausting memory and match the limits of the .NET adapter, so the same UI
// renders identical truncation behavior for every language binding.
const (
	// MaxLogs is the number of log entries retained for one request.
	MaxLogs = 500
	// MaxEffects is the number of side effects retained for one request.
	MaxEffects = 100
	// MaxChanges is the number of row changes retained for one request.
	MaxChanges = 200
	// MaxProperties is the number of structured properties kept on one log entry.
	MaxProperties = 32
	// MaxParameters is the number of SQL parameters, JSON members and headers kept.
	MaxParameters = 64

	maxName          = 256
	maxText          = 4096
	maxPayloadBytes  = 16 * 1024
	logBudget        = 128 * 1024
	payloadBudget    = 128 * 1024
	maxPayloadDepth  = 16
	maxPreviewBody   = 1024 * 1024
	redactedValue    = "[REDACTED]"
	rollbackPrefer   = "tx=rollback"
	previewPrefix    = "/sendproof/_preview"
	workbenchPrefix  = "/sendproof"
	traceHeader      = "X-Sendproof-Trace"
	serverTimingName = "Server-Timing"
)

// clip shortens value to at most maximum bytes without splitting a UTF-8 sequence.
func clip(value string, maximum int) string {
	if len(value) <= maximum {
		return value
	}
	cut := maximum
	for cut > 0 && !utf8.RuneStart(value[cut]) {
		cut--
	}
	return value[:cut]
}

// snapshotJSON serializes a host-provided value for capture. Host payloads may be
// cyclic, oversized or fail in a marshaler, and capture must never interrupt the
// application, so any problem yields ok=false instead of an error.
func snapshotJSON(value any) (raw json.RawMessage, ok bool) {
	defer func() {
		if recover() != nil {
			raw, ok = nil, false
		}
	}()
	encoded, err := json.Marshal(value)
	if err != nil || len(encoded) > maxPayloadBytes {
		return nil, false
	}
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.UseNumber()
	var tree any
	if decoder.Decode(&tree) != nil || !fits(tree, 0) {
		return nil, false
	}
	return json.RawMessage(encoded), true
}

// fits reports whether a decoded JSON value stays within the depth, string and
// collection limits of a captured payload.
func fits(value any, depth int) bool {
	if depth >= maxPayloadDepth {
		return false
	}
	switch typed := value.(type) {
	case string:
		return len(typed) <= maxText
	case []any:
		if len(typed) > MaxParameters {
			return false
		}
		for _, item := range typed {
			if !fits(item, depth+1) {
				return false
			}
		}
	case map[string]any:
		if len(typed) > MaxParameters {
			return false
		}
		for name, item := range typed {
			if len(name) > maxName || !fits(item, depth+1) {
				return false
			}
		}
	}
	return true
}
