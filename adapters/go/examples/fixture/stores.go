package fixture

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/aws/smithy-go/middleware"
	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/mprync/sendproof/adapters/go/dynamobench"
	"github.com/mprync/sendproof/adapters/go/mongobench"
	"github.com/mprync/sendproof/adapters/go/redisbench"
	"github.com/mprync/sendproof/adapters/go/sendproof"
)

// dataStores holds the clients of the stores the runner provisioned for this
// process. A store is hooked only when the runner passed its variables
// (spec/conformance/fixture.md, "Data store routes").
type dataStores struct {
	registered []sendproof.DataStore

	mongo     *mongobench.Collection
	mongoDone func()

	redis       *redis.Client
	redisPrefix string

	dynamo      *dynamodb.Client
	dynamoTable string
}

// openDataStores connects the stores whose variables are set. Call close to release them.
func openDataStores(ctx context.Context) (*dataStores, error) {
	d := &dataStores{}
	if raw := os.Getenv("BENCH_MONGODB_URL"); raw != "" {
		if err := d.openMongo(ctx, raw); err != nil {
			return nil, err
		}
	}
	if raw := os.Getenv("BENCH_REDIS_URL"); raw != "" {
		options, err := redis.ParseURL(raw)
		if err != nil {
			return nil, err
		}
		d.redis = redis.NewClient(options)
		d.redis.AddHook(redisbench.Hook())
		d.redisPrefix = os.Getenv("BENCH_REDIS_PREFIX")
		d.registered = append(d.registered, redisbench.Store("cache"))
	}
	if endpoint := os.Getenv("BENCH_DYNAMODB_URL"); endpoint != "" {
		d.dynamo = dynamodb.New(dynamodb.Options{
			Region: os.Getenv("AWS_REGION"), BaseEndpoint: aws.String(endpoint),
			Credentials: credentials.NewStaticCredentialsProvider(os.Getenv("AWS_ACCESS_KEY_ID"), os.Getenv("AWS_SECRET_ACCESS_KEY"), ""),
			APIOptions:  []func(*middleware.Stack) error{dynamobench.Middleware()},
		})
		d.dynamoTable = os.Getenv("BENCH_DYNAMODB_TABLE")
		d.registered = append(d.registered, dynamobench.Store("orders"))
	}
	return d, nil
}

func (d *dataStores) openMongo(ctx context.Context, raw string) error {
	parsed, err := url.Parse(raw)
	if err != nil {
		return err
	}
	store := mongobench.New(mongobench.WithName("catalog"))
	client, err := store.Connect(options.Client().ApplyURI(raw))
	if err != nil {
		return err
	}
	d.mongo = client.Database(strings.TrimPrefix(parsed.Path, "/")).Collection("documents")
	d.mongoDone = func() {
		release, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = client.Disconnect(release)
	}
	d.registered = append(d.registered, store)
	return nil
}

func (d *dataStores) close() {
	if d == nil {
		return
	}
	if d.mongoDone != nil {
		d.mongoDone()
	}
	if d.redis != nil {
		_ = d.redis.Close()
	}
}

// routes lists the data-store routes of the stores that are hooked. The
// preview: false routes name the store they write.
func (d *dataStores) routes() []route {
	var list []route
	if d == nil {
		return list
	}
	if d.mongo != nil {
		list = append(list,
			route{method: "GET", path: "/documents/{id}", preview: true, handler: func(h *handlers) http.HandlerFunc { return h.stores.readDocument }},
			route{method: "POST", path: "/documents", admin: true, preview: true, handler: func(h *handlers) http.HandlerFunc { return h.stores.createDocument }},
			route{method: "PATCH", path: "/documents/{id}", admin: true, preview: true, handler: func(h *handlers) http.HandlerFunc { return h.stores.patchDocument }},
			route{method: "POST", path: "/documents/archive", admin: true, preview: true, handler: func(h *handlers) http.HandlerFunc { return h.stores.archiveDocuments }},
			route{method: "DELETE", path: "/documents/{id}", admin: true, store: "mongodb", handler: func(h *handlers) http.HandlerFunc { return h.stores.deleteDocument }},
		)
	}
	if d.redis != nil {
		list = append(list,
			route{method: "GET", path: "/counters/{key}", preview: true, handler: func(h *handlers) http.HandlerFunc { return h.stores.readCounter }},
			route{method: "POST", path: "/counters/{key}", admin: true, preview: true, handler: func(h *handlers) http.HandlerFunc { return h.stores.incrementCounter }},
			route{method: "POST", path: "/counters/{key}/take", admin: true, preview: true, handler: func(h *handlers) http.HandlerFunc { return h.stores.takeCounter }},
			route{method: "DELETE", path: "/counters/{key}", admin: true, store: "redis", handler: func(h *handlers) http.HandlerFunc { return h.stores.deleteCounter }},
		)
	}
	if d.dynamo != nil {
		list = append(list,
			route{method: "GET", path: "/orders/{id}", preview: true, handler: func(h *handlers) http.HandlerFunc { return h.stores.readOrder }},
			route{method: "POST", path: "/orders/{id}/touch", admin: true, preview: true, handler: func(h *handlers) http.HandlerFunc { return h.stores.touchOrder }},
			route{method: "POST", path: "/orders/{id}/cancel", admin: true, preview: true, handler: func(h *handlers) http.HandlerFunc { return h.stores.cancelOrder }},
			route{method: "DELETE", path: "/orders/{id}", admin: true, store: "dynamodb", handler: func(h *handlers) http.HandlerFunc { return h.stores.deleteOrder }},
		)
	}
	if d.redis != nil || d.dynamo != nil {
		list = append(list, route{method: "POST", path: "/items/{id}/remember", admin: true, preview: true, handler: func(h *handlers) http.HandlerFunc { return h.remember }})
	}
	return list
}

// ---- MongoDB ----

// document is the shape stored in the documents collection.
type document struct {
	ID           string            `bson:"_id"`
	Name         string            `bson:"name"`
	Profile      map[string]string `bson:"profile"`
	PasswordHash string            `bson:"password_hash"`
}

func shape(found document) map[string]any {
	return map[string]any{"id": found.ID, "name": found.Name, "city": found.Profile["city"]}
}

func (d *dataStores) readDocument(w http.ResponseWriter, r *http.Request) {
	var found document
	err := d.mongo.FindOne(r.Context(), bson.D{{Key: "_id", Value: r.PathValue("id")}}).Decode(&found)
	switch {
	case errors.Is(err, mongo.ErrNoDocuments):
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
	case err != nil:
		storeFailure(w, err)
	default:
		writeJSON(w, http.StatusOK, shape(found))
	}
}

func (d *dataStores) createDocument(w http.ResponseWriter, r *http.Request) {
	var body struct{ ID, Name, City, Password string }
	if json.NewDecoder(r.Body).Decode(&body) != nil || body.ID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "id, name, city and password are required"})
		return
	}
	created := document{ID: body.ID, Name: body.Name, Profile: map[string]string{"city": body.City}, PasswordHash: "hashed:" + body.Password}
	if _, err := d.mongo.InsertOne(r.Context(), created); err != nil {
		storeFailure(w, err)
		return
	}
	sendproof.Log(r.Context(), "Information", "created-document:"+body.ID)
	writeJSON(w, http.StatusCreated, shape(created))
}

func (d *dataStores) patchDocument(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name *string `json:"name"`
		City *string `json:"city"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	set := bson.D{}
	if body.Name != nil {
		set = append(set, bson.E{Key: "name", Value: *body.Name})
	}
	if body.City != nil {
		set = append(set, bson.E{Key: "profile.city", Value: *body.City})
	}
	id := r.PathValue("id")
	result, err := d.mongo.UpdateOne(r.Context(), bson.D{{Key: "_id", Value: id}}, bson.D{{Key: "$set", Value: set}})
	if err != nil {
		storeFailure(w, err)
		return
	}
	if result.MatchedCount == 0 {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	var found document
	if err := d.mongo.FindOne(r.Context(), bson.D{{Key: "_id", Value: id}}).Decode(&found); err != nil {
		storeFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, shape(found))
}

// archiveDocuments runs $out, which MongoDB cannot run in a transaction: a Preview
// blocks it before it is sent.
func (d *dataStores) archiveDocuments(w http.ResponseWriter, r *http.Request) {
	pipeline := bson.A{bson.D{{Key: "$match", Value: bson.D{}}}, bson.D{{Key: "$out", Value: "documents_archive"}}}
	cursor, err := d.mongo.Aggregate(r.Context(), pipeline)
	if err != nil {
		storeFailure(w, err)
		return
	}
	_ = cursor.Close(r.Context())
	w.WriteHeader(http.StatusNoContent)
}

func (d *dataStores) deleteDocument(w http.ResponseWriter, r *http.Request) {
	if _, err := d.mongo.DeleteOne(r.Context(), bson.D{{Key: "_id", Value: r.PathValue("id")}}); err != nil {
		storeFailure(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---- Redis ----

func (d *dataStores) counterKey(r *http.Request) string {
	return d.redisPrefix + "counter:" + r.PathValue("key")
}

func counterReply(w http.ResponseWriter, key string, value int64) {
	writeJSON(w, http.StatusOK, map[string]any{"key": key, "value": value})
}

func (d *dataStores) readCounter(w http.ResponseWriter, r *http.Request) {
	value, err := d.redis.Get(r.Context(), d.counterKey(r)).Int64()
	switch {
	case errors.Is(err, redis.Nil):
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
	case err != nil:
		storeFailure(w, err)
	default:
		counterReply(w, r.PathValue("key"), value)
	}
}

func (d *dataStores) incrementCounter(w http.ResponseWriter, r *http.Request) {
	value, err := d.redis.Incr(r.Context(), d.counterKey(r)).Result()
	if err != nil {
		storeFailure(w, err)
		return
	}
	counterReply(w, r.PathValue("key"), value)
}

// takeCounter uses GETDEL, which looks like a read but deletes the key. It swallows
// nothing: the Preview must still fail whatever the handler does with the refusal.
func (d *dataStores) takeCounter(w http.ResponseWriter, r *http.Request) {
	text, err := d.redis.GetDel(r.Context(), d.counterKey(r)).Result()
	if errors.Is(err, redis.Nil) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if err != nil {
		storeFailure(w, err)
		return
	}
	value, _ := strconv.ParseInt(text, 10, 64)
	counterReply(w, r.PathValue("key"), value)
}

func (d *dataStores) deleteCounter(w http.ResponseWriter, r *http.Request) {
	if err := d.redis.Del(r.Context(), d.counterKey(r)).Err(); err != nil {
		storeFailure(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---- DynamoDB ----

func (d *dataStores) orderKey(id string) map[string]types.AttributeValue {
	return map[string]types.AttributeValue{"id": &types.AttributeValueMemberS{Value: id}}
}

// orderShape reads the item's attributes as {id, status, hits}.
func orderShape(attributes map[string]types.AttributeValue) map[string]any {
	result := map[string]any{}
	if value, ok := attributes["id"].(*types.AttributeValueMemberS); ok {
		result["id"] = value.Value
	}
	if value, ok := attributes["status"].(*types.AttributeValueMemberS); ok {
		result["status"] = value.Value
	}
	if value, ok := attributes["hits"].(*types.AttributeValueMemberN); ok {
		hits, _ := strconv.ParseInt(value.Value, 10, 64)
		result["hits"] = hits
	}
	return result
}

func (d *dataStores) readOrder(w http.ResponseWriter, r *http.Request) {
	out, err := d.dynamo.GetItem(r.Context(), &dynamodb.GetItemInput{TableName: aws.String(d.dynamoTable), Key: d.orderKey(r.PathValue("id"))})
	switch {
	case err != nil:
		storeFailure(w, err)
	case out.Item == nil:
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
	default:
		writeJSON(w, http.StatusOK, orderShape(out.Item))
	}
}

// touch is the UpdateItem the contract describes; the "remember" route reuses it.
func (d *dataStores) touch(ctx context.Context, id string) (map[string]any, error) {
	out, err := d.dynamo.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName: aws.String(d.dynamoTable), Key: d.orderKey(id), ReturnValues: types.ReturnValueAllNew,
		UpdateExpression:         aws.String("ADD hits :one SET #s = if_not_exists(#s, :new)"),
		ExpressionAttributeNames: map[string]string{"#s": "status"},
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":one": &types.AttributeValueMemberN{Value: "1"}, ":new": &types.AttributeValueMemberS{Value: "new"},
		},
	})
	if err != nil {
		return nil, err
	}
	return orderShape(out.Attributes), nil
}

func (d *dataStores) touchOrder(w http.ResponseWriter, r *http.Request) {
	shaped, err := d.touch(r.Context(), r.PathValue("id"))
	if err != nil {
		storeFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, shaped)
}

// cancelOrder sends a PartiQL UPDATE through ExecuteStatement, the action that also carries reads.
func (d *dataStores) cancelOrder(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	_, err := d.dynamo.ExecuteStatement(r.Context(), &dynamodb.ExecuteStatementInput{
		Statement:  aws.String(`UPDATE "` + d.dynamoTable + `" SET status = 'cancelled' WHERE id = ?`),
		Parameters: []types.AttributeValue{&types.AttributeValueMemberS{Value: id}},
	})
	if err != nil {
		storeFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": id, "status": "cancelled"})
}

func (d *dataStores) deleteOrder(w http.ResponseWriter, r *http.Request) {
	if _, err := d.dynamo.DeleteItem(r.Context(), &dynamodb.DeleteItemInput{TableName: aws.String(d.dynamoTable), Key: d.orderKey(r.PathValue("id"))}); err != nil {
		storeFailure(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// remember inserts the item into SQL, then writes the named guarded store, so the
// Preview must roll the SQL write back and block on the store write.
func (h *handlers) remember(w http.ResponseWriter, r *http.Request) {
	var body item
	body.ID = r.PathValue("id")
	if json.NewDecoder(r.Body).Decode(&body) != nil || strings.TrimSpace(body.Name) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "name is required"})
		return
	}
	ctx := r.Context()
	if err := h.store.insert(ctx, body.ID, body.Name); err != nil {
		h.fail(w, err)
		return
	}
	d := h.stores
	var err error
	switch r.URL.Query().Get("store") {
	case "redis":
		err = d.redis.Incr(ctx, d.redisPrefix+"counter:item-"+body.ID).Err()
	case "dynamodb":
		_, err = d.touch(ctx, "item-"+body.ID)
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "store must be redis or dynamodb"})
		return
	}
	if err != nil {
		storeFailure(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, body)
}

// storeFailure answers a store error. A blocked write is the guard's refusal; the
// handler reports it like any application error and the Preview still answers 409.
func storeFailure(w http.ResponseWriter, err error) {
	writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "the store failed: " + err.Error()})
}
