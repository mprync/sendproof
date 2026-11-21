package mongobench

import (
	"bytes"
	"encoding/hex"
	"strings"

	"github.com/mprync/sendproof/adapters/go/stores"
	"go.mongodb.org/mongo-driver/v2/bson"
)

func lower(s string) string { return strings.ToLower(s) }

// sessionID renders a session id document ({id: <UUID>}) as hex, comparable
// between the driver's session and the lsid of a monitored command.
func sessionID(raw bson.Raw) (string, bool) {
	value, err := raw.LookupErr("id")
	if err != nil {
		return "", false
	}
	_, data, ok := value.BinaryOK()
	if !ok {
		return "", false
	}
	return hex.EncodeToString(data), true
}

// rawToDoc converts a BSON document to the ordered neutral form the classifiers
// read. Scalars become nil: the classifiers and the sanitizer never read values.
func rawToDoc(raw bson.Raw) stores.Doc {
	elements, err := raw.Elements()
	if err != nil {
		return nil
	}
	doc := make(stores.Doc, 0, len(elements))
	for _, element := range elements {
		doc = append(doc, stores.Field{Key: element.Key(), Value: valueToNeutral(element.Value())})
	}
	return doc
}

func valueToNeutral(value bson.RawValue) any {
	switch value.Type {
	case bson.TypeEmbeddedDocument:
		return rawToDoc(value.Document())
	case bson.TypeArray:
		values, err := value.Array().Values()
		if err != nil {
			return []any{}
		}
		list := make([]any, 0, len(values))
		for _, item := range values {
			list = append(list, valueToNeutral(item))
		}
		return list
	case bson.TypeString:
		return value.StringValue()
	}
	return nil
}

// toRaw marshals a driver argument (bson.D, bson.M, a struct) to a BSON document.
func toRaw(document any) (bson.Raw, error) {
	switch typed := document.(type) {
	case bson.Raw:
		return typed, nil
	case nil:
		return bson.Raw{}, nil
	}
	data, err := bson.Marshal(document)
	return bson.Raw(data), err
}

// pipelineDoc wraps a pipeline argument (mongo.Pipeline, []bson.D, bson.A) in a
// command document, so the classifier can scan every stage at any depth.
func pipelineDoc(collection string, pipeline any) stores.Doc {
	raw, err := toRaw(bson.D{{Key: "aggregate", Value: collection}, {Key: "pipeline", Value: pipeline}})
	if err != nil {
		// A pipeline the driver cannot marshal is classified as an unknown write.
		return stores.Doc{{Key: "aggregate", Value: collection}, {Key: "pipeline", Value: []any{stores.Doc{{Key: "$out", Value: nil}}}}}
	}
	return rawToDoc(raw)
}

// extJSON renders a document as MongoDB Extended JSON v2 relaxed form, for change
// snapshots; BSON types without a JSON equivalent become {"$oid": ...}, {"$date": ...}.
func extJSON(raw bson.Raw) []byte {
	data, err := bson.MarshalExtJSON(raw, false, false)
	if err != nil {
		return []byte("null")
	}
	return data
}

// extJSONValue renders one value the same way.
func extJSONValue(name string, value bson.RawValue) []byte {
	document, err := bson.Marshal(bson.D{{Key: name, Value: value}})
	if err != nil {
		return []byte("null")
	}
	return extJSON(document)
}

func sameDocument(a, b bson.Raw) bool { return bytes.Equal(a, b) }
