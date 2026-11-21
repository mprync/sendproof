package sendproof

import (
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"
)

// Option configures a Sendproof. Options validate their input, and New reports the
// first failure.
type Option func(*config) error

// config holds the validated settings of a Sendproof.
type config struct {
	apiName       string
	openAPIURL    string
	documents     []document
	fieldModules  []string
	environment   string
	environments  []string
	authProviders []authProvider
	principal     func(*http.Request) (Principal, bool)
	access        func(*http.Request) bool
	providers     []Provider
	pathBase      string
	traceTTL      time.Duration
	clock         func() time.Time
	logger        *slog.Logger
	sqlValues     *bool
}

type document struct{ Name, URL string }

type authProvider struct{ Label, Kind, URL string }

func defaultConfig() config {
	environment := firstNonEmpty(os.Getenv("SENDPROOF_ENVIRONMENT"), os.Getenv("APP_ENV"), os.Getenv("GO_ENV"), "Production")
	return config{
		apiName:      "API",
		openAPIURL:   "/openapi/v1.json",
		environment:  environment,
		environments: []string{"Development"},
		traceTTL:     5 * time.Minute,
		clock:        time.Now,
		logger:       slog.Default(),
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

// WithAPIName sets the API name shown in the workbench. The default is "API".
func WithAPIName(name string) Option {
	return func(c *config) error {
		if strings.TrimSpace(name) == "" {
			return errors.New("sendproof: the API name must not be empty")
		}
		c.apiName = name
		return nil
	}
}

// WithOpenAPIURL sets the application-relative path and optional query of the
// same-origin OpenAPI document. The default is /openapi/v1.json.
func WithOpenAPIURL(url string) Option {
	return func(c *config) error {
		if err := validateLocalURL(url); err != nil {
			return err
		}
		c.openAPIURL = url
		return nil
	}
}

// WithOpenAPIDocument adds a named same-origin OpenAPI document to the selector.
// Adding a name again replaces the earlier document.
func WithOpenAPIDocument(name, url string) Option {
	return func(c *config) error {
		if strings.TrimSpace(name) == "" {
			return errors.New("sendproof: the document name must not be empty")
		}
		if err := validateLocalURL(url); err != nil {
			return err
		}
		kept := c.documents[:0]
		for _, existing := range c.documents {
			if !strings.EqualFold(existing.Name, name) {
				kept = append(kept, existing)
			}
		}
		c.documents = append(kept, document{Name: name, URL: url})
		return nil
	}
}

// WithFieldModule loads custom field renderers from a JavaScript module that the
// host serves from its own origin. The module exports a fieldRenderers array.
func WithFieldModule(url string) Option {
	return func(c *config) error {
		if err := validateLocalURL(url); err != nil {
			return err
		}
		for _, existing := range c.fieldModules {
			if existing == url {
				return nil
			}
		}
		c.fieldModules = append(c.fieldModules, url)
		return nil
	}
}

// WithEnvironment names the environment the application runs in, such as
// "Development". The default comes from SENDPROOF_ENVIRONMENT, APP_ENV or GO_ENV,
// and is "Production" when none is set, so the workbench stays off by default.
func WithEnvironment(name string) Option {
	return func(c *config) error {
		if strings.TrimSpace(name) == "" {
			return errors.New("sendproof: the environment name must not be empty")
		}
		c.environment = name
		return nil
	}
}

// WithEnabledEnvironments replaces the list of environments in which the
// workbench and Preview are available. The default is Development only.
func WithEnabledEnvironments(names ...string) Option {
	return func(c *config) error {
		if len(names) == 0 {
			return errors.New("sendproof: list at least one environment")
		}
		for _, name := range names {
			if strings.TrimSpace(name) == "" {
				return errors.New("sendproof: an environment name must not be empty")
			}
		}
		c.environments = append([]string(nil), names...)
		return nil
	}
}

// WithAuthProvider advertises a host-managed sign-in integration. The url is an
// application-relative path such as /auth/sign-in, and kind is, for example,
// "passwordJson", "personas", "oidc" or "login".
func WithAuthProvider(label, kind, url string) Option {
	return func(c *config) error {
		if strings.TrimSpace(label) == "" || strings.TrimSpace(kind) == "" {
			return errors.New("sendproof: an auth provider needs a label and a kind")
		}
		if err := validateLocalURL(url); err != nil {
			return err
		}
		c.authProviders = append(c.authProviders, authProvider{Label: label, Kind: kind, URL: url})
		return nil
	}
}

// WithPrincipal supplies the function that resolves the authenticated identity of
// a request. It feeds the identity shown in the workbench and the owner of
// observed-send traces. It must report false for an anonymous request and must
// not write a response.
func WithPrincipal(resolve func(*http.Request) (Principal, bool)) Option {
	return func(c *config) error {
		c.principal = resolve
		return nil
	}
}

// WithAccessPolicy restricts the workbench routes, Preview and observed sends to
// requests that the policy allows. A denied request without a principal receives
// HTTP 401, and any other denied request receives HTTP 403.
func WithAccessPolicy(allow func(*http.Request) bool) Option {
	return func(c *config) error {
		c.access = allow
		return nil
	}
}

// WithProvider registers the data layer that Preview rolls back. Register exactly
// one provider; with several, Preview is unavailable because no provider can be
// chosen safely.
func WithProvider(provider Provider) Option {
	return func(c *config) error {
		if provider == nil {
			return errors.New("sendproof: the provider must not be nil")
		}
		c.providers = append(c.providers, provider)
		return nil
	}
}

// WithPathBase declares a mount prefix that a reverse proxy strips before the
// request reaches the application. Emitted URLs, such as discovery links and
// redirects, include it. Use StripPathBase when the application strips the prefix
// itself.
func WithPathBase(base string) Option {
	return func(c *config) error {
		normalized, err := normalizePathBase(base)
		if err != nil {
			return err
		}
		c.pathBase = normalized
		return nil
	}
}

// WithTraceTTL sets how long observed-send traces stay readable. The default is
// five minutes. Tests can shorten it.
func WithTraceTTL(ttl time.Duration) Option {
	return func(c *config) error {
		if ttl <= 0 {
			return errors.New("sendproof: the trace lifetime must be positive")
		}
		c.traceTTL = ttl
		return nil
	}
}

// WithClock replaces the clock that expires traces, so tests can advance time.
func WithClock(now func() time.Time) Option {
	return func(c *config) error {
		if now == nil {
			return errors.New("sendproof: the clock must not be nil")
		}
		c.clock = now
		return nil
	}
}

// WithLogger sets the logger for Sendproof's own diagnostics. The default is
// slog.Default.
func WithLogger(logger *slog.Logger) Option {
	return func(c *config) error {
		if logger == nil {
			return errors.New("sendproof: the logger must not be nil")
		}
		c.logger = logger
		return nil
	}
}

// WithSQLParameterValues controls capture of non-secret SQL parameter values. By
// default they are included only in the Development environment. Secret-looking
// names are redacted either way.
func WithSQLParameterValues(enabled bool) Option {
	return func(c *config) error {
		c.sqlValues = &enabled
		return nil
	}
}

func validateLocalURL(url string) error {
	if !isLocalURL(url) {
		return fmt.Errorf("sendproof: %q is not an application-relative, same-origin path", url)
	}
	return nil
}
