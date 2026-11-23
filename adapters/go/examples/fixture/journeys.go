package fixture

import "github.com/mprync/sendproof/adapters/go/sendproof"

const readItemOperationID = "readItem"

type itemLookupInputs struct {
	ID string `json:"id,omitempty" jsonschema:"default=conformance-item"`
}

func itemJourneys() sendproof.JourneyDocument {
	return sendproof.JourneyDocument{
		ID: "items", Name: "Conformance journeys", SourceName: "fixture",
		Journeys: []sendproof.Journey{{
			ID: "itemLookup", Name: "Look up an item", Inputs: itemLookupInputs{},
			Steps: []sendproof.JourneyStep{{
				ID: "getItem", OperationID: readItemOperationID,
				Parameters:      []sendproof.JourneyParameter{{Name: "id", In: "path", Value: sendproof.Input("id")}},
				SuccessCriteria: []sendproof.JourneyCriterion{sendproof.StatusIs(200)},
			}},
		}},
	}
}
