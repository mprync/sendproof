package sendproof

import (
	"bytes"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	"github.com/invopop/jsonschema"
)

func buildJourneyStep(step JourneyStep, operations map[string]bool, inputs *jsonschema.Schema, outputs map[string]map[string]string) (arazzoStep, map[string]any, error) {
	var arazzo arazzoStep
	if !arazzoName.MatchString(step.ID) {
		return arazzo, nil, fmt.Errorf("invalid step ID %q", step.ID)
	}
	if _, seen := outputs[step.ID]; seen {
		return arazzo, nil, fmt.Errorf("duplicate step ID %q", step.ID)
	}
	if !operations[step.OperationID] {
		return arazzo, nil, fmt.Errorf("unknown operationId %q in the app's OpenAPI document", step.OperationID)
	}
	arazzo = arazzoStep{
		ID: step.ID, OperationID: step.OperationID,
		Parameters: step.Parameters, Outputs: step.Outputs, SuccessCriteria: step.SuccessCriteria,
	}
	if step.Body != nil {
		body := *step.Body
		body.ContentType = firstNonEmpty(body.ContentType, "application/json")
		arazzo.Body = &body
	}
	if err := validateJourneyRefs(arazzo, inputs, outputs); err != nil {
		return arazzo, nil, err
	}

	// Write expectations are evaluated after the response, so they can also
	// refer to an output of the current step.
	outputs[step.ID] = step.Outputs
	rules := map[string]any{}
	if step.RunAs != "" {
		rules["persona"] = step.RunAs
	}
	if expected := step.ExpectWrites; expected != nil {
		writes := expected.Writes
		if writes == nil {
			writes = []WriteExpectation{}
		}
		rules["writes"], rules["unlisted"] = writes, "fail"
		if len(expected.Effects) > 0 {
			rules["effects"] = expected.Effects
		} else if len(writes) == 0 {
			rules["effects"] = []EffectExpectation{}
		}
	}
	if err := validateJourneyRefs(rules, inputs, outputs); err != nil {
		return arazzo, nil, err
	}
	return arazzo, rules, nil
}

var embeddedJourneyRef = regexp.MustCompile(`\{(\$(?:inputs|steps)(?:\.[^{}\s]+)?)\}`)

// Check the names used by the runner, including bindings inside a JSON payload
// or interpolated into a Redis key. The runner evaluates the expressions.
func validateJourneyRefs(value any, inputs *jsonschema.Schema, outputs map[string]map[string]string) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	var tree any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(&tree); err != nil {
		return err
	}
	var walk func(any) error
	walk = func(value any) error {
		switch node := value.(type) {
		case map[string]any:
			for _, item := range node {
				if err := walk(item); err != nil {
					return err
				}
			}
		case []any:
			for _, item := range node {
				if err := walk(item); err != nil {
					return err
				}
			}
		case string:
			if err := validateJourneyRef(node, inputs, outputs); err != nil {
				return err
			}
			for _, match := range embeddedJourneyRef.FindAllStringSubmatch(node, -1) {
				if err := validateJourneyRef(match[1], inputs, outputs); err != nil {
					return err
				}
			}
		}
		return nil
	}
	return walk(tree)
}

func validateJourneyRef(ref string, inputs *jsonschema.Schema, outputs map[string]map[string]string) error {
	if name, ok := strings.CutPrefix(ref, "$inputs."); ok {
		name, _, _ = strings.Cut(name, ".")
		if inputs != nil {
			if _, found := inputs.Properties.Get(name); found {
				return nil
			}
		}
		return fmt.Errorf("unknown input %q in %s", name, ref)
	}
	if name, ok := strings.CutPrefix(ref, "$steps."); ok {
		parts := strings.SplitN(name, ".", 4)
		if len(parts) < 3 || parts[1] != "outputs" || parts[2] == "" {
			return fmt.Errorf("invalid step output reference %q", ref)
		}
		step, ok := outputs[parts[0]]
		if !ok {
			return fmt.Errorf("unknown or later step %q in %s", parts[0], ref)
		}
		if _, found := step[parts[2]]; !found {
			return fmt.Errorf("unknown output %q on step %q in %s", parts[2], parts[0], ref)
		}
	}
	return nil
}
