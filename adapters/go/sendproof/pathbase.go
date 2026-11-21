package sendproof

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"
)

type pathBaseKey struct{}

// normalizePathBase validates a mount prefix and returns it without a trailing
// slash. The empty string means the application is mounted at the origin root.
func normalizePathBase(base string) (string, error) {
	if base == "" || base == "/" {
		return "", nil
	}
	if !strings.HasPrefix(base, "/") || !isLocalURL(base) || strings.ContainsAny(base, "?") {
		return "", errors.New("sendproof: the path base must start with / and contain no query")
	}
	return strings.TrimRight(base, "/"), nil
}

// StripPathBase mounts next under a path prefix, like http.StripPrefix, and also
// records the prefix so Sendproof and the application can build correct URLs
// with PathBase. A request outside the prefix receives HTTP 404, so nothing is
// reachable at the unprefixed origin. An empty base returns next unchanged.
func StripPathBase(base string, next http.Handler) http.Handler {
	normalized, err := normalizePathBase(base)
	if err != nil {
		panic(err)
	}
	if normalized == "" {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path, escaped := r.URL.Path, r.URL.EscapedPath()
		if !hasSegmentPrefix(path, normalized) || !hasSegmentPrefix(escaped, normalized) {
			http.NotFound(w, r)
			return
		}
		stripped := *r.URL
		stripped.Path = path[len(normalized):]
		stripped.RawPath = ""
		if rest := escaped[len(normalized):]; rest != (&url.URL{Path: stripped.Path}).EscapedPath() {
			stripped.RawPath = rest
		}
		if stripped.Path == "" {
			stripped.Path = "/"
			stripped.RawPath = ""
		}
		inner := r.WithContext(context.WithValue(r.Context(), pathBaseKey{}, normalized))
		inner.URL = &stripped
		next.ServeHTTP(w, inner)
	})
}

// PathBase returns the mount prefix of the request, such as "/tenant", or the
// empty string when the application is mounted at the root. Use it to build
// absolute-path URLs, for example in a redirect Location.
func PathBase(r *http.Request) string {
	base, _ := r.Context().Value(pathBaseKey{}).(string)
	return base
}

// withPathBase stores a configured base in the request context unless
// StripPathBase already recorded one.
func withPathBase(r *http.Request, configured string) *http.Request {
	if configured == "" || PathBase(r) != "" {
		return r
	}
	return r.WithContext(context.WithValue(r.Context(), pathBaseKey{}, configured))
}
