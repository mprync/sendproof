package sendproof

import (
	"context"
	"fmt"
	"log/slog"
)

// slogHandler copies records into the active preview or observed trace and then
// forwards them to the application's own handler.
type slogHandler struct {
	next   slog.Handler
	attrs  []slog.Attr
	groups []string
}

// SlogHandler wraps next so that records logged with a request context, such as
// logger.InfoContext(ctx, ...), also appear in the preview or observed trace.
// Records logged without the request context, or outside Sendproof, only reach
// next. A nil next records without forwarding.
func SlogHandler(next slog.Handler) slog.Handler {
	return &slogHandler{next: next}
}

func (h *slogHandler) Enabled(ctx context.Context, level slog.Level) bool {
	// Capture every level while a trace is active; forwarding keeps its own filter.
	if IsCapturing(ctx) {
		return true
	}
	return h.next != nil && h.next.Enabled(ctx, level)
}

func (h *slogHandler) Handle(ctx context.Context, record slog.Record) error {
	if state := stateFrom(ctx); state != nil && state.rec != nil && state.rec.isActive() {
		props := map[string]string{}
		for _, attr := range h.attrs {
			addAttr(props, "", attr)
		}
		record.Attrs(func(attr slog.Attr) bool {
			addAttr(props, groupPrefix(h.groups), attr)
			return true
		})
		var failure error
		if value, ok := props["error"]; ok {
			failure = fmt.Errorf("%s", value)
		}
		state.rec.recordStructured(levelName(record.Level), "", record.Message, props, failure)
	}
	if h.next != nil && h.next.Enabled(ctx, record.Level) {
		return h.next.Handle(ctx, record)
	}
	return nil
}

func (h *slogHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	clone := *h
	clone.attrs = append(append([]slog.Attr(nil), h.attrs...), attrs...)
	if h.next != nil {
		clone.next = h.next.WithAttrs(attrs)
	}
	return &clone
}

func (h *slogHandler) WithGroup(name string) slog.Handler {
	clone := *h
	clone.groups = append(append([]string(nil), h.groups...), name)
	if h.next != nil {
		clone.next = h.next.WithGroup(name)
	}
	return &clone
}

func groupPrefix(groups []string) string {
	prefix := ""
	for _, group := range groups {
		prefix += group + "."
	}
	return prefix
}

func addAttr(props map[string]string, prefix string, attr slog.Attr) {
	attr.Value = attr.Value.Resolve()
	if attr.Equal(slog.Attr{}) {
		return
	}
	if attr.Value.Kind() == slog.KindGroup {
		for _, member := range attr.Value.Group() {
			addAttr(props, prefix+attr.Key+".", member)
		}
		return
	}
	name := prefix + attr.Key
	if IsSecretName(name) {
		props[name] = redactedValue // for example password=..., api_key=...
		return
	}
	props[name] = attr.Value.String()
}

// levelName maps slog levels to the display names the workbench uses.
func levelName(level slog.Level) string {
	switch {
	case level >= slog.LevelError:
		return "Error"
	case level >= slog.LevelWarn:
		return "Warning"
	case level >= slog.LevelInfo:
		return "Information"
	default:
		return "Debug"
	}
}
