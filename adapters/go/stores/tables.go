package stores

import (
	"embed"
	"encoding/json"
	"fmt"
	"strings"
)

// The shared classification tables of spec/data-stores/, copied here unchanged by
// `go generate` (the copies are generated files: never edit them). A parity test
// fails when a copy differs from the spec.
//
//go:generate go run ./internal/embedtables ../../../spec/data-stores tables

//go:embed tables/*.json
var tableFiles embed.FS

// redisTable, mongoTable and dynamoTable are the parsed tables.
var (
	redisTable  = loadRedis()
	mongoTable  = loadMongo()
	dynamoTable = loadDynamo()
)

type redisFile struct {
	Read        []string `json:"read"`
	ModuleRead  []string `json:"moduleRead"`
	Session     []string `json:"session"`
	Transaction []string `json:"transaction"`
}

type mongoFile struct {
	Read             []string `json:"read"`
	Session          []string `json:"session"`
	NotInTransaction struct {
		Commands []string `json:"commands"`
		Stages   []string `json:"stages"`
	} `json:"notInTransaction"`
}

type dynamoFile struct {
	Read    []string `json:"read"`
	PartiQL struct {
		Operations []string `json:"operations"`
	} `json:"partiql"`
}

// set builds a lookup set, lower-casing the names when fold is true.
func set(names []string, fold bool) map[string]bool {
	result := make(map[string]bool, len(names))
	for _, name := range names {
		if fold {
			name = strings.ToLower(name)
		}
		result[name] = true
	}
	return result
}

func readTable(name string, into any) {
	data, err := tableFiles.ReadFile("tables/" + name)
	if err == nil {
		err = json.Unmarshal(data, into)
	}
	if err != nil {
		panic(fmt.Sprintf("stores: the embedded table %s is unreadable: %v", name, err))
	}
}

type redisSets struct{ read, session, transaction map[string]bool }

func loadRedis() redisSets {
	var file redisFile
	readTable("redis.json", &file)
	return redisSets{
		read:        set(append(append([]string{}, file.Read...), file.ModuleRead...), false),
		session:     set(file.Session, false),
		transaction: set(file.Transaction, false),
	}
}

type mongoSets struct {
	read, session, notInTransaction map[string]bool
	stages                          []string
}

func loadMongo() mongoSets {
	var file mongoFile
	readTable("mongodb.json", &file)
	return mongoSets{
		read: set(file.Read, true), session: set(file.Session, true),
		notInTransaction: set(file.NotInTransaction.Commands, true), stages: file.NotInTransaction.Stages,
	}
}

type dynamoSets struct{ read, partiql map[string]bool }

func loadDynamo() dynamoSets {
	var file dynamoFile
	readTable("dynamodb.json", &file)
	return dynamoSets{read: set(file.Read, false), partiql: set(file.PartiQL.Operations, false)}
}

// ---- Batch two ----

// cassandraTable, searchTable, cosmosTable and firestoreTable are the parsed
// batch-two tables.
var (
	cassandraTable = loadCassandra()
	searchTable    = loadSearch()
	cosmosTable    = loadCosmos()
	firestoreTable = loadFirestore()
)

type cassandraSets struct{ read, session map[string]bool }

func loadCassandra() cassandraSets {
	var file struct {
		Read     []string `json:"read"`
		Protocol struct {
			Session []string `json:"session"`
		} `json:"protocol"`
	}
	readTable("cassandra.json", &file)
	return cassandraSets{read: set(file.Read, false), session: set(file.Protocol.Session, false)}
}

// searchEndpoint is one entry of elasticsearch.json, with its paths split into segments.
type searchEndpoint struct {
	Kind    string     `json:"kind"`
	Name    string     `json:"name"`
	Methods []string   `json:"methods"`
	Paths   []string   `json:"paths"`
	paths   [][]string `json:"-"`
}

type searchSets struct {
	endpoints    []searchEndpoint
	sqlReadWords map[string]bool
}

func loadSearch() searchSets {
	var file struct {
		Endpoints []searchEndpoint `json:"endpoints"`
		SQL       struct {
			ReadWords []string `json:"readWords"`
		} `json:"sql"`
	}
	readTable("elasticsearch.json", &file)
	for index := range file.Endpoints {
		entry := &file.Endpoints[index]
		for _, path := range entry.Paths {
			entry.paths = append(entry.paths, strings.Split(strings.Trim(path, "/"), "/"))
		}
	}
	return searchSets{endpoints: file.Endpoints, sqlReadWords: set(file.SQL.ReadWords, false)}
}

type cosmosSets struct {
	// read holds the lower-case read operation types; spelling maps every listed
	// lower-case operation type to its reported spelling.
	read     map[string]bool
	spelling map[string]string
}

func loadCosmos() cosmosSets {
	var file struct {
		Read  []string `json:"read"`
		Write []string `json:"write"`
	}
	readTable("cosmosdb.json", &file)
	sets := cosmosSets{read: set(file.Read, true), spelling: map[string]string{}}
	for _, name := range append(append([]string{}, file.Read...), file.Write...) {
		sets.spelling[strings.ToLower(name)] = name
	}
	return sets
}

type firestoreSets struct {
	read, session     map[string]bool
	adminReadPrefixes []string
	restVerbs         map[string]string
}

func loadFirestore() firestoreSets {
	var file struct {
		Services map[string]struct {
			Read         []string `json:"read"`
			Session      []string `json:"session"`
			ReadPrefixes []string `json:"readPrefixes"`
		} `json:"services"`
		FromRest struct {
			Verbs map[string]string `json:"verbs"`
		} `json:"fromRest"`
	}
	readTable("firestore.json", &file)
	service := file.Services["google.firestore.v1.Firestore"]
	return firestoreSets{
		read: set(service.Read, false), session: set(service.Session, false),
		adminReadPrefixes: file.Services["google.firestore.admin.v1.FirestoreAdmin"].ReadPrefixes,
		restVerbs:         file.FromRest.Verbs,
	}
}
