package sendproof

import (
	"net/http"
	"strconv"
)

// JourneyDocument groups journeys served in one Arazzo and expectations pair.
type JourneyDocument struct {
	ID         string // The filename stem, such as "store".
	Name       string
	SourceName string // The Arazzo name of the OpenAPI source. Defaults to "api".
	Journeys   []Journey
}

// Journey defines a workflow and its expectations.
type Journey struct {
	ID             string
	Name           string // The workflow summary. Defaults to ID.
	Description    string
	Group          string
	RunAs          string // The development persona's email.
	SendOnlyReason string
	Inputs         any // A struct value or pointer, reflected using json and jsonschema tags.
	Steps          []JourneyStep
}

// JourneyStep invokes an operation from the app's OpenAPI document.
type JourneyStep struct {
	ID              string
	OperationID     string
	Parameters      []JourneyParameter
	Body            *JourneyBody
	Outputs         map[string]string
	SuccessCriteria []JourneyCriterion
	RunAs           string // Overrides the journey's persona for this step.
	ExpectWrites    *StepWrites
}

// JourneyParameter binds a path, query, header or cookie parameter to a value.
type JourneyParameter struct {
	Name  string `json:"name"`
	In    string `json:"in"`
	Value any    `json:"value"`
}

// JourneyBody binds a request payload. ContentType defaults to application/json.
type JourneyBody struct {
	ContentType string `json:"contentType"`
	Payload     any    `json:"payload"`
}

// JourneyCriterion is an Arazzo success assertion. An empty Type means simple.
type JourneyCriterion struct {
	Condition string `json:"condition"`
	Context   string `json:"context,omitempty"`
	Type      string `json:"type,omitempty"`
}

// Input references a journey input by its JSON name.
func Input(name string) string { return "$inputs." + name }

// StepOutput references a named output from another step.
func StepOutput(step, name string) string { return "$steps." + step + ".outputs." + name }

// ResponseBody reads the current response at a JSON Pointer such as "/id".
// An empty pointer reads the entire body.
func ResponseBody(pointer string) string {
	if pointer == "" {
		return "$response.body"
	}
	return "$response.body#" + pointer
}

// StatusIs asserts the response status code.
func StatusIs(code int) JourneyCriterion {
	return JourneyCriterion{Condition: "$statusCode == " + strconv.Itoa(code)}
}

// StepWrites describes the writes and effects a step should produce. A non-nil
// empty StepWrites expects no writes or effects.
type StepWrites struct {
	Writes              []WriteExpectation
	Effects             []EffectExpectation
	ApprovedDifferences []ApprovedDifference
}

// WriteExpectation targets a store by its capabilities ID. SQL writes name a
// table, document writes a collection, and Redis commands use a string Key.
// For row or document writes Key is a map of identity fields.
type WriteExpectation struct {
	Store      string         `json:"store"`
	Table      string         `json:"table,omitempty"`
	Collection string         `json:"collection,omitempty"`
	Op         string         `json:"op"`
	Key        any            `json:"key,omitempty"`
	Values     map[string]any `json:"values,omitempty"`
}

// EffectExpectation uses the effect's wire format, including its kind.
type EffectExpectation map[string]any

// Email expects an outbound email to the given recipient with the given subject.
func Email(to, subject any) EffectExpectation {
	return EffectExpectation{"kind": "email", "to": to, "subject": subject}
}

// Any matches a value of the given JSON type or format, or any value with "any".
func Any(kind string) map[string]any { return map[string]any{"type": kind} }

// Pattern matches a string using a regular expression.
func Pattern(pattern string) map[string]any { return map[string]any{"pattern": pattern} }

// Changed matches both the previous and new values of an update.
func Changed(from, to any) map[string]any { return map[string]any{"from": from, "to": to} }

// ApprovedDifference covers a specific comparison finding on its step.
// Dates use YYYY-MM-DD. Kind is "value", "missing" or "extra".
type ApprovedDifference struct {
	ID         string           `json:"id"`
	Target     DifferenceTarget `json:"target"`
	Kind       string           `json:"kind"`
	Expected   any              `json:"expected,omitempty"`
	Actual     any              `json:"actual,omitempty"`
	Reason     string           `json:"reason"`
	ApprovedBy string           `json:"approvedBy"`
	ApprovedOn string           `json:"approvedOn"`
	Expires    string           `json:"expires,omitempty"`
	Link       string           `json:"link,omitempty"`
}

// DifferenceTarget identifies the store, resource and field a finding concerns.
type DifferenceTarget struct {
	Store      string `json:"store,omitempty"`
	Table      string `json:"table,omitempty"`
	Collection string `json:"collection,omitempty"`
	Key        any    `json:"key,omitempty"`
	Field      string `json:"field,omitempty"`
}

// WithCodeJourneys adds code-defined journeys beside file journeys. Supply the
// same JSON OpenAPI handler the app serves at WithOpenAPIURL. New invokes that
// handler once for validation, before the app starts serving requests.
func WithCodeJourneys(openAPI http.Handler, documents ...JourneyDocument) Option {
	return func(c *config) error {
		c.codeJourneys = append(c.codeJourneys, codeJourneyRegistration{openAPI, documents})
		return nil
	}
}
