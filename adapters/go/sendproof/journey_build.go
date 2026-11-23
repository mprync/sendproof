package sendproof

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"time"

	"github.com/invopop/jsonschema"
)

type codeJourneyRegistration struct {
	openAPI   http.Handler
	documents []JourneyDocument
}

var arazzoName = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

func (c *config) buildCodeJourneys() error {
	registrations := c.codeJourneys
	c.codeJourneys = nil
	if len(registrations) == 0 {
		return nil
	}
	stems := make(map[string]bool, len(c.journeys))
	for _, doc := range c.journeys {
		stems[doc.stem] = true
	}
	var problems []error
	for _, registration := range registrations {
		operations, err := openAPIOperations(registration.openAPI, c.openAPIURL)
		if err != nil {
			problems = append(problems, err)
			continue
		}
		for _, definition := range registration.documents {
			if stems[definition.ID] {
				problems = append(problems, fmt.Errorf("journey document %q is already registered", definition.ID))
				continue
			}
			doc, errs := buildJourneyDocument(definition, c.openAPIURL, operations)
			problems = append(problems, errs...)
			if doc != nil {
				c.journeys = append(c.journeys, *doc)
				stems[doc.stem] = true
			}
		}
	}
	if len(problems) == 0 {
		return nil
	}
	if strings.EqualFold(c.environment, "Development") {
		return fmt.Errorf("sendproof: invalid code journeys: %w", errors.Join(problems...))
	}
	for _, problem := range problems {
		c.logger.Warn("Skipped a code journey", "problem", problem.Error())
	}
	return nil
}

func openAPIOperations(handler http.Handler, url string) (map[string]bool, error) {
	if handler == nil {
		return nil, errors.New("code journeys require the app's OpenAPI handler")
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, url, nil))
	if recorder.Code != http.StatusOK {
		return nil, fmt.Errorf("journey OpenAPI handler for %s returned HTTP %d", url, recorder.Code)
	}
	var doc struct {
		OpenAPI string
		Paths   map[string]map[string]json.RawMessage
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &doc); err != nil {
		return nil, fmt.Errorf("read journey OpenAPI document at %s: %w", url, err)
	}
	if !strings.HasPrefix(doc.OpenAPI, "3.") {
		return nil, fmt.Errorf("journey OpenAPI document at %s must use OpenAPI 3", url)
	}
	operations := make(map[string]bool)
	for path, item := range doc.Paths {
		for _, method := range []string{"get", "put", "post", "delete", "options", "head", "patch", "trace", "query"} {
			raw, ok := item[method]
			if !ok {
				continue
			}
			var operation struct{ OperationID string }
			if err := json.Unmarshal(raw, &operation); err != nil {
				return nil, fmt.Errorf("read OpenAPI operation %s %s: %w", method, path, err)
			}
			if operation.OperationID == "" {
				continue
			}
			if operations[operation.OperationID] {
				return nil, fmt.Errorf("OpenAPI operationId %q is ambiguous", operation.OperationID)
			}
			operations[operation.OperationID] = true
		}
	}
	return operations, nil
}

type arazzoWorkflow struct {
	ID          string             `json:"workflowId"`
	Summary     string             `json:"summary"`
	Description string             `json:"description,omitempty"`
	Inputs      *jsonschema.Schema `json:"inputs,omitempty"`
	Steps       []arazzoStep       `json:"steps"`
}

type arazzoStep struct {
	ID              string             `json:"stepId"`
	OperationID     string             `json:"operationId"`
	Parameters      []JourneyParameter `json:"parameters,omitempty"`
	Body            *JourneyBody       `json:"requestBody,omitempty"`
	Outputs         map[string]string  `json:"outputs,omitempty"`
	SuccessCriteria []JourneyCriterion `json:"successCriteria,omitempty"`
}

type approvedDifferenceEntry struct {
	ApprovedDifference
	Journey string `json:"journey"`
	Step    string `json:"step"`
}

func buildJourneyDocument(doc JourneyDocument, url string, operations map[string]bool) (*journeyDocument, []error) {
	source := firstNonEmpty(doc.SourceName, "api")
	if !journeyName.MatchString(doc.ID) || strings.TrimSpace(doc.Name) == "" || !arazzoName.MatchString(source) || len(doc.Journeys) == 0 {
		return nil, []error{fmt.Errorf("journey document %q needs a valid ID, name, source name and at least one journey", doc.ID)}
	}
	var workflows []arazzoWorkflow
	var approvals []approvedDifferenceEntry
	var problems []error
	entries := map[string]any{}
	workflowIDs := map[string]bool{}
	approvalIDs := map[string]bool{}
	for _, journey := range doc.Journeys {
		workflow, entry, records, err := buildJourney(doc.ID, journey, operations, approvalIDs)
		if err != nil {
			problems = append(problems, fmt.Errorf("journey %s/%s: %w", doc.ID, journey.ID, err))
			continue
		}
		if workflowIDs[journey.ID] {
			problems = append(problems, fmt.Errorf("journey document %q repeats workflow ID %q", doc.ID, journey.ID))
			continue
		}
		workflowIDs[journey.ID] = true
		workflows = append(workflows, workflow)
		if len(entry) > 0 {
			entries[journey.ID] = entry
		}
		for _, record := range records {
			approvalIDs[record.ID] = true
		}
		approvals = append(approvals, records...)
	}
	if len(workflows) == 0 {
		return nil, problems
	}
	arazzo, err := json.Marshal(map[string]any{
		"arazzo": "1.1.0", "info": map[string]string{"title": doc.Name, "version": "1.0.0"},
		"sourceDescriptions": []map[string]string{{"name": source, "url": url, "type": "openapi"}},
		"workflows":          workflows,
	})
	if err != nil {
		return nil, append(problems, fmt.Errorf("write journey document %q: %w", doc.ID, err))
	}
	rules := map[string]any{"sendproofExpectations": "1.0", "arazzo": doc.ID + ".arazzo.json", "journeys": entries}
	if len(approvals) > 0 {
		rules["approvedDifferences"] = approvals
	}
	expectations, err := json.Marshal(rules)
	if err != nil {
		return nil, append(problems, fmt.Errorf("write journey expectations %q: %w", doc.ID, err))
	}
	return &journeyDocument{doc.Name, doc.ID, "code", arazzo, expectations}, problems
}

func buildJourney(document string, journey Journey, operations map[string]bool, approvalIDs map[string]bool) (arazzoWorkflow, map[string]any, []approvedDifferenceEntry, error) {
	var workflow arazzoWorkflow
	if !journeyName.MatchString(journey.ID) || len(journey.Steps) == 0 {
		return workflow, nil, nil, errors.New("a valid ID and at least one step are required")
	}
	inputs, err := journeyInputSchema(journey.Inputs, document+":"+journey.ID)
	if err != nil {
		return workflow, nil, nil, err
	}
	workflow = arazzoWorkflow{ID: journey.ID, Summary: firstNonEmpty(journey.Name, journey.ID), Description: journey.Description, Inputs: inputs}
	steps := map[string]any{}
	entry := map[string]any{}
	if journey.Group != "" {
		entry["group"] = journey.Group
	}
	if journey.RunAs != "" {
		entry["runAs"] = journey.RunAs
	}
	sendOnly := journey.SendOnlyReason
	outputs := map[string]map[string]string{}
	var approvals []approvedDifferenceEntry
	localApprovalIDs := map[string]bool{}
	var problems []error
	for _, step := range journey.Steps {
		arazzo, rules, err := buildJourneyStep(step, operations, inputs, outputs)
		if err != nil {
			problems = append(problems, fmt.Errorf("step %q: %w", step.ID, err))
		}
		workflow.Steps = append(workflow.Steps, arazzo)
		if len(rules) > 0 {
			steps[step.ID] = rules
		}
		if step.ExpectWrites == nil {
			continue
		}
		for _, write := range step.ExpectWrites.Writes {
			if write.Store == "redis" && sendOnly == "" {
				sendOnly = fmt.Sprintf("Step %s writes to Redis, which can't roll back.", step.ID)
			}
		}
		for _, approval := range step.ExpectWrites.ApprovedDifferences {
			if err := validateApproval(approval, approvalIDs[approval.ID] || localApprovalIDs[approval.ID]); err != nil {
				problems = append(problems, fmt.Errorf("step %q: %w", step.ID, err))
				continue
			}
			localApprovalIDs[approval.ID] = true
			approvals = append(approvals, approvedDifferenceEntry{approval, journey.ID, step.ID})
		}
	}
	if sendOnly != "" {
		entry["sendOnly"], entry["sendOnlyReason"] = true, sendOnly
	}
	if len(steps) > 0 {
		entry["steps"] = steps
	}
	return workflow, entry, approvals, errors.Join(problems...)
}

func journeyInputSchema(value any, id string) (*jsonschema.Schema, error) {
	if value == nil {
		return nil, nil
	}
	reflector := jsonschema.Reflector{Anonymous: true, AllowAdditionalProperties: true}
	reflected := reflector.Reflect(value)
	root := reflected
	if definition := reflected.Definitions[strings.TrimPrefix(reflected.Ref, "#/$defs/")]; definition != nil {
		root = definition
	}
	if root.Type != "object" || root.Properties == nil {
		return nil, errors.New("inputs must be a Go struct")
	}
	schema := *root
	schema.Version, schema.Definitions = "", nil
	raw, err := json.Marshal(&schema)
	if err != nil {
		return nil, fmt.Errorf("write input schema: %w", err)
	}
	// An embedded schema with references needs its own URI so #/$defs resolves
	// within the schema rather than against the surrounding Arazzo document.
	if bytes.Contains(raw, []byte(`"$ref":"#/$defs/`)) {
		schema.ID = jsonschema.ID("urn:sendproof:journey:" + id)
		schema.Definitions = reflected.Definitions
	}
	return &schema, nil
}

func validateApproval(approval ApprovedDifference, duplicate bool) error {
	switch {
	case strings.TrimSpace(approval.ID) == "" || strings.TrimSpace(approval.Reason) == "" || strings.TrimSpace(approval.ApprovedBy) == "":
		return errors.New("an approved difference requires an ID, reason and approvedBy")
	case duplicate:
		return fmt.Errorf("approved difference %q already covers an expectation", approval.ID)
	case approval.Kind != "value" && approval.Kind != "missing" && approval.Kind != "extra":
		return fmt.Errorf("approved difference %q has an unknown kind %q", approval.ID, approval.Kind)
	case approval.Target.Store == "" || approval.Target.Table == "" && approval.Target.Collection == "" && approval.Target.Key == nil:
		return fmt.Errorf("approved difference %q needs a specific store and target", approval.ID)
	}
	if _, err := time.Parse(time.DateOnly, approval.ApprovedOn); err != nil {
		return fmt.Errorf("approved difference %q approvedOn must use YYYY-MM-DD", approval.ID)
	}
	if _, err := time.Parse(time.DateOnly, approval.Expires); approval.Expires != "" && err != nil {
		return fmt.Errorf("approved difference %q expires must use YYYY-MM-DD", approval.ID)
	}
	_, err := json.Marshal(approval)
	return err
}
