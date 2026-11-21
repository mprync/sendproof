package testbench

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"unicode/utf8"
)

// errPreviewTooLarge is returned to a handler whose preview response exceeds the cap.
var errPreviewTooLarge = errors.New("testbench: the preview response exceeds the 1 MiB limit")

// captureWriter buffers the response of a previewed handler. Nothing reaches the
// client, so the real response can describe the preview itself.
type captureWriter struct {
	header   http.Header
	status   int
	wrote    bool
	body     bytes.Buffer
	exceeded bool
}

func newCaptureWriter() *captureWriter {
	return &captureWriter{header: http.Header{}, status: http.StatusOK}
}

func (c *captureWriter) Header() http.Header { return c.header }

func (c *captureWriter) WriteHeader(status int) {
	// Informational responses other than the final status are not part of the result.
	if c.wrote || status >= 100 && status < 200 && status != http.StatusSwitchingProtocols {
		return
	}
	c.wrote, c.status = true, status
}

func (c *captureWriter) Write(data []byte) (int, error) {
	if !c.wrote {
		c.WriteHeader(http.StatusOK)
	}
	if c.header.Get("Content-Type") == "" && c.header.Get("Content-Encoding") == "" && c.body.Len() == 0 && len(data) > 0 {
		// Mirror net/http, which sniffs the type when a handler sets none.
		if _, set := c.header["Content-Type"]; !set {
			c.header.Set("Content-Type", http.DetectContentType(data))
		}
	}
	if c.body.Len()+len(data) > maxPreviewBody {
		c.exceeded = true
		return 0, errPreviewTooLarge
	}
	return c.body.Write(data)
}

// Flush satisfies http.Flusher. The preview stays buffered until the handler returns.
func (c *captureWriter) Flush() {}

// privateHeaders never leave a preview: they would set cookies, redirect the
// browser, or describe the transport of the captured response.
var privateHeaders = map[string]bool{
	"set-cookie": true, "location": true, "content-length": true, "transfer-encoding": true,
	"connection": true, "upgrade": true, "trailer": true,
}

// envelopeHeaders returns the lowercase, bounded header map of the envelope.
func (c *captureWriter) envelopeHeaders() map[string]string {
	headers := make(map[string]string)
	for name, values := range c.header {
		lower := strings.ToLower(name)
		if privateHeaders[lower] || len(lower) > maxName {
			continue
		}
		if len(headers) == MaxParameters {
			break
		}
		headers[lower] = clip(strings.Join(values, ", "), maxText)
	}
	return headers
}

// envelopeBody decodes the captured body: JSON stays structured, text becomes a
// string, and anything else is base64.
func (c *captureWriter) envelopeBody() any {
	data := c.body.Bytes()
	if len(data) == 0 {
		return nil
	}
	contentType, _, _ := strings.Cut(c.header.Get("Content-Type"), ";")
	contentType = strings.ToLower(strings.TrimSpace(contentType))
	if contentType == "application/json" || strings.HasSuffix(contentType, "+json") {
		if json.Valid(data) {
			return json.RawMessage(bytes.Clone(data))
		}
		return string(bytes.ToValidUTF8(data, []byte("�")))
	}
	if contentType == "" || strings.HasPrefix(contentType, "text/") {
		if utf8.Valid(data) {
			return string(data)
		}
		return string(bytes.ToValidUTF8(data, []byte("�")))
	}
	return base64.StdEncoding.EncodeToString(data)
}

// snapshotChanges bounds a provider's changes by count, size and shape, and
// reports whether anything was left out.
func snapshotChanges(changes []Change) (result []Change, truncated bool) {
	result = make([]Change, 0, min(len(changes), MaxChanges))
	truncated = len(changes) > MaxChanges
	remaining := payloadBudget
	for index, change := range changes {
		if index == MaxChanges {
			break
		}
		key, keyOK := snapshotValue(change.Key)
		before, beforeOK := snapshotValue(change.Before)
		after, afterOK := snapshotValue(change.After)
		operation, table := clip(change.Operation, maxName), clip(change.Table, maxName)
		remaining -= rawSize(key) + rawSize(before) + rawSize(after) + len(operation) + len(table)
		if remaining < 0 {
			truncated = true
			break
		}
		truncated = truncated || !keyOK || !beforeOK || !afterOK || operation != change.Operation || table != change.Table
		result = append(result, Change{Operation: operation, Table: table, Key: key, Before: before, After: after})
	}
	return result, truncated
}

func snapshotValue(value any) (any, bool) {
	if value == nil {
		return nil, true
	}
	raw, ok := snapshotJSON(value)
	if !ok {
		return nil, false
	}
	return redactSecretMembers(raw), true
}

// redactSecretMembers hides the values of the secret-named members of a row
// snapshot, such as password_hash or api_key, the way SQL parameters with those
// names are hidden. Values other than JSON objects are returned unchanged.
func redactSecretMembers(raw json.RawMessage) json.RawMessage {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return raw
	}
	var members map[string]json.RawMessage
	decoder := json.NewDecoder(bytes.NewReader(trimmed))
	decoder.UseNumber()
	if decoder.Decode(&members) != nil {
		return raw
	}
	changed := false
	for name := range members {
		if IsSecretName(name) {
			members[name] = json.RawMessage(`"` + redactedValue + `"`)
			changed = true
		}
	}
	if !changed {
		return raw
	}
	encoded, err := json.Marshal(members)
	if err != nil {
		return raw
	}
	return encoded
}

func rawSize(value any) int {
	if raw, ok := value.(json.RawMessage); ok {
		return len(raw)
	}
	return 0
}
