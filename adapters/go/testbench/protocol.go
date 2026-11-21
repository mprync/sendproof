package testbench

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"unicode"
)

// isLocalURL reports whether value is an application-relative path (with an
// optional query) that cannot escape the origin.
func isLocalURL(value string) bool {
	path, _, _ := strings.Cut(value, "?")
	decoded, err := url.PathUnescape(path)
	if err != nil || !strings.HasPrefix(path, "/") || strings.HasPrefix(decoded, "//") {
		return false
	}
	if strings.ContainsAny(value, "#\\") || strings.Contains(decoded, "\\") {
		return false
	}
	for _, segment := range strings.Split(decoded, "/") {
		if segment == "." || segment == ".." {
			return false
		}
	}
	for _, r := range value + decoded {
		if unicode.IsSpace(r) || unicode.IsControl(r) {
			return false
		}
	}
	return true
}

// preferTokens splits every Prefer header value into trimmed comma-separated tokens.
func preferTokens(r *http.Request) []string {
	var tokens []string
	for _, value := range r.Header.Values("Prefer") {
		for _, token := range strings.Split(value, ",") {
			tokens = append(tokens, strings.TrimSpace(token))
		}
	}
	return tokens
}

// requestsRollback reports whether any Prefer header asks for tx=rollback.
func requestsRollback(r *http.Request) bool {
	for _, value := range r.Header.Values("Prefer") {
		for _, part := range strings.FieldsFunc(value, func(c rune) bool { return c == ',' || c == ';' }) {
			name, setting, found := strings.Cut(strings.TrimSpace(part), "=")
			if found && strings.EqualFold(strings.TrimSpace(name), "tx") &&
				strings.EqualFold(strings.Trim(strings.TrimSpace(setting), `"`), "rollback") {
				return true
			}
		}
	}
	return false
}

// hasExactRollbackPreference accepts only a single Prefer header of exactly tx=rollback.
func hasExactRollbackPreference(r *http.Request) bool {
	values := r.Header.Values("Prefer")
	return len(values) == 1 && strings.EqualFold(strings.TrimSpace(values[0]), rollbackPrefer)
}

// requestsTrace reports whether a Prefer header contains the trace token.
func requestsTrace(r *http.Request) bool {
	for _, token := range preferTokens(r) {
		name, _, _ := strings.Cut(token, ";")
		if strings.EqualFold(strings.TrimSpace(name), "trace") {
			return true
		}
	}
	return false
}

// isSameOrigin rejects cross-site browser requests, so another site cannot make a
// signed-in developer's browser run a preview or collect a trace.
func isSameOrigin(r *http.Request) bool {
	if strings.EqualFold(r.Header.Get("Sec-Fetch-Site"), "cross-site") {
		return false
	}
	origins := r.Header.Values("Origin")
	if len(origins) == 0 {
		return true
	}
	if len(origins) != 1 {
		return false
	}
	origin, err := url.Parse(origins[0])
	if err != nil || origin.Scheme == "" || origin.Host == "" {
		return false
	}
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	return origin.Scheme == scheme && strings.EqualFold(origin.Host, r.Host) && origin.User == nil &&
		(origin.Path == "" || origin.Path == "/") && origin.RawQuery == "" && origin.Fragment == ""
}

// reject writes a problem-details response. Rejections are never cacheable.
func reject(w http.ResponseWriter, status int, title string) {
	headers := w.Header()
	headers.Set("Cache-Control", "no-store")
	headers.Set("Content-Type", "application/problem+json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"title": title, "status": status})
}

// writeJSON writes a non-cacheable JSON response.
func writeJSON(w http.ResponseWriter, status int, value any) {
	encoded, err := json.Marshal(value)
	if err != nil {
		reject(w, http.StatusInternalServerError, "The response could not be serialized.")
		return
	}
	headers := w.Header()
	headers.Set("Content-Type", "application/json; charset=utf-8")
	headers.Set("Cache-Control", "no-store")
	headers.Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_, _ = w.Write(encoded)
}

// validTarget checks the path a preview targets.
func validTarget(escaped string) bool {
	if escaped == "" || strings.HasPrefix(escaped, "//") {
		return false
	}
	decoded, err := url.PathUnescape(escaped)
	if err != nil || strings.HasPrefix(decoded, "//") || strings.Contains(decoded, "\\") {
		return false
	}
	for _, r := range decoded {
		if unicode.IsControl(r) {
			return false
		}
	}
	for _, segment := range strings.Split(decoded, "/") {
		if segment == "." || segment == ".." {
			return false
		}
	}
	return !hasSegmentPrefix(decoded, workbenchPrefix)
}

// hasSegmentPrefix reports whether path equals prefix or continues it at a segment boundary.
func hasSegmentPrefix(path, prefix string) bool {
	return path == prefix || strings.HasPrefix(path, prefix+"/")
}

// secretWords and secretKeyQualifiers drive IsSecretName. Words are matched whole,
// so IdempotencyKey or Monkey stay visible while PasswordHash, api_key and
// RefreshToken are hidden.
var secretWords = map[string]bool{
	"password": true, "passwd": true, "pwd": true, "secret": true, "token": true,
	"hash": true, "salt": true, "credential": true, "credentials": true, "apikey": true,
}

// "key" alone is ordinary (primary key, idempotency key); it is secret only after these words.
var secretKeyQualifiers = map[string]bool{
	"api": true, "private": true, "secret": true, "access": true, "signing": true, "encryption": true, "client": true,
}

// IsSecretName reports whether an identifier or SQL statement names a secret,
// judged by whole words split at punctuation, underscores and camel-case
// boundaries. Providers use it to decide which values to redact.
func IsSecretName(text string) bool {
	previous := ""
	for _, word := range splitWords(text) {
		lower := strings.ToLower(word)
		if secretWords[lower] || lower == "key" && previous != "" && secretKeyQualifiers[previous] {
			return true
		}
		previous = lower
	}
	return false
}

func splitWords(text string) []string {
	var words []string
	runes := []rune(text)
	start := -1
	for i := 0; i <= len(runes); i++ {
		alnum := i < len(runes) && (unicode.IsLetter(runes[i]) || unicode.IsDigit(runes[i]))
		boundary := !alnum || start >= 0 && unicode.IsUpper(runes[i]) && unicode.IsLower(runes[i-1])
		if boundary && start >= 0 {
			words = append(words, string(runes[start:i]))
			start = -1
		}
		if alnum && start < 0 {
			start = i
		}
	}
	return words
}
