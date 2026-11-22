/**
 * Data-store routes of the conformance fixture (spec/conformance/fixture.md "Data store routes").
 *
 * Each store is hooked only when the runner passes its variables, so the standard and alternate
 * scenarios run without any store service. The routes use the clients exactly as an application
 * would: MongoDB through `mongoStore(...).client`, Redis through the hooked ioredis client,
 * DynamoDB through the hooked AWS SDK client, Cassandra through the hooked `cassandra-driver`
 * client and OpenSearch through the hooked OpenSearch client's transport.
 */
import { currentCapture } from '@sendproof/core';

/**
 * Build the hooked stores and their routes. `operation` and `reply` come from the fixture service;
 * `insertItem` writes the SQL item for the mixed SQL-and-store route.
 */
export async function createStoreRoutes({ operation, reply, insertItem }) {
  const dataStores = [];
  const operations = [];
  const unavailable = [];
  const closers = [];
  const env = process.env;
  const text = value => typeof value === 'string' && value.length > 0 && value.length <= 150;
  const unavailableOperation = (method, path, stores, handler) => unavailable.push({ ...operation(method, path, handler), options: { stores } });

  let redis;
  let dynamo;
  let touch;

  if (env.BENCH_MONGODB_URL) {
    const [{ MongoClient }, { mongoStore }] = await Promise.all([import('mongodb'), import('@sendproof/mongodb')]);
    const store = mongoStore(new MongoClient(env.BENCH_MONGODB_URL), { name: 'catalog' });
    dataStores.push(store);
    closers.push(() => store.client.close());
    const documents = () => store.client.db().collection('documents');
    const shape = document => ({ id: document._id, name: document.name, city: document.profile?.city ?? null });
    operations.push(
      operation('GET', '/documents/{id}', async ({ params }) => {
        const document = await documents().findOne({ _id: params.id });
        return document ? reply(200, shape(document)) : reply(404);
      }),
      operation('POST', '/documents', async ({ body }) => {
        if (![body?.id, body?.name, body?.city, body?.password].every(text)) return reply(400);
        const document = { _id: body.id, name: body.name, profile: { city: body.city }, password_hash: 'hashed:' + body.password };
        await documents().insertOne(document);
        currentCapture()?.log({ level: 'Information', message: 'created-document:' + body.id });
        return reply(201, shape(document));
      }),
      operation('PATCH', '/documents/{id}', async ({ params, body }) => {
        const set = {};
        if (body?.name !== undefined) set.name = body.name;
        if (body?.city !== undefined) set['profile.city'] = body.city;
        if (!Object.values(set).every(text)) return reply(400);
        const result = await documents().updateOne({ _id: params.id }, { $set: set });
        if (!result.matchedCount) return reply(404);
        return reply(200, shape(await documents().findOne({ _id: params.id })));
      }),
      operation('POST', '/documents/archive', async () => {
        await documents().aggregate([{ $match: {} }, { $out: 'documents_archive' }]).toArray();
        return reply(204);
      }),
    );
    unavailableOperation('DELETE', '/documents/{id}', ['mongodb'], async ({ params }) => {
      await documents().deleteOne({ _id: params.id });
      return reply(204);
    });
  }

  if (env.BENCH_REDIS_URL) {
    const [{ Redis }, { redisStore }] = await Promise.all([import('ioredis'), import('@sendproof/redis')]);
    redis = new Redis(env.BENCH_REDIS_URL, { lazyConnect: true });
    dataStores.push(redisStore(redis, { name: 'cache' }));
    await redis.connect();
    closers.push(() => redis.quit());
    const key = name => `${env.BENCH_REDIS_PREFIX ?? ''}counter:${name}`;
    operations.push(
      operation('GET', '/counters/{key}', async ({ params }) => {
        const value = await redis.get(key(params.key));
        return value === null ? reply(404) : reply(200, { key: params.key, value: Number(value) });
      }),
      operation('POST', '/counters/{key}', async ({ params }) => reply(200, { key: params.key, value: await redis.incr(key(params.key)) })),
      operation('POST', '/counters/{key}/take', async ({ params }) => {
        // Store errors are swallowed on purpose: the blocked mark, not the response, decides a Preview.
        let value = null;
        try { value = await redis.getdel(key(params.key)); } catch { /* reported as not found */ }
        return value === null ? reply(404) : reply(200, { key: params.key, value: Number(value) });
      }),
    );
    unavailableOperation('DELETE', '/counters/{key}', ['redis'], async ({ params }) => {
      await redis.del(key(params.key));
      return reply(204);
    });
  }

  if (env.BENCH_DYNAMODB_URL) {
    const [{ DynamoDBClient, DeleteItemCommand, ExecuteStatementCommand, GetItemCommand, UpdateItemCommand }, { dynamoStore }] =
      await Promise.all([import('@aws-sdk/client-dynamodb'), import('@sendproof/dynamodb')]);
    dynamo = new DynamoDBClient({ endpoint: env.BENCH_DYNAMODB_URL, region: env.AWS_REGION ?? 'us-east-1' });
    dataStores.push(dynamoStore(dynamo, { name: 'orders' }));
    closers.push(async () => dynamo.destroy());
    const table = env.BENCH_DYNAMODB_TABLE;
    const order = item => ({ id: item.id.S, status: item.status?.S ?? null, hits: Number(item.hits?.N ?? 0) });
    touch = async id => order((await dynamo.send(new UpdateItemCommand({
      TableName: table, Key: { id: { S: id } }, UpdateExpression: 'ADD hits :one SET #s = if_not_exists(#s, :new)',
      ExpressionAttributeNames: { '#s': 'status' }, ExpressionAttributeValues: { ':one': { N: '1' }, ':new': { S: 'new' } },
      ReturnValues: 'ALL_NEW',
    }))).Attributes);
    operations.push(
      operation('GET', '/orders/{id}', async ({ params }) => {
        const { Item } = await dynamo.send(new GetItemCommand({ TableName: table, Key: { id: { S: params.id } }, ConsistentRead: true }));
        return Item ? reply(200, order(Item)) : reply(404);
      }),
      operation('POST', '/orders/{id}/touch', async ({ params }) => reply(200, await touch(params.id))),
      operation('POST', '/orders/{id}/cancel', async ({ params }) => {
        await dynamo.send(new ExecuteStatementCommand({ Statement: `UPDATE "${table}" SET status = 'cancelled' WHERE id = ?`, Parameters: [{ S: params.id }] }));
        return reply(200, { id: params.id, status: 'cancelled' });
      }),
    );
    unavailableOperation('DELETE', '/orders/{id}', ['dynamodb'], async ({ params }) => {
      await dynamo.send(new DeleteItemCommand({ TableName: table, Key: { id: { S: params.id } } }));
      return reply(204);
    });
  }

  let touchTicket;
  let touchArticle;

  if (env.BENCH_CASSANDRA_CONTACT_POINT) {
    const [{ Client }, { cassandraStore }] = await Promise.all([import('cassandra-driver'), import('@sendproof/cassandra')]);
    const cassandra = new Client({
      contactPoints: [env.BENCH_CASSANDRA_CONTACT_POINT], localDataCenter: 'datacenter1', keyspace: env.BENCH_CASSANDRA_KEYSPACE,
    });
    dataStores.push(cassandraStore(cassandra, { name: 'tickets' }));
    await cassandra.connect();
    closers.push(() => cassandra.shutdown());
    // Every statement is prepared, so the guard classifies the text the route passes and never sees a bound value.
    const ticket = row => ({ id: row.id, status: row.status ?? null, hits: row.hits ?? 0 });
    touchTicket = async id => {
      await cassandra.execute("INSERT INTO tickets (id, status, hits) VALUES (?, 'new', 1)", [id], { prepare: true });
      return { id, status: 'new', hits: 1 };
    };
    operations.push(
      operation('GET', '/tickets/{id}', async ({ params }) => {
        const result = await cassandra.execute('SELECT id, status, hits FROM tickets WHERE id = ?', [params.id], { prepare: true });
        return result.rowLength ? reply(200, ticket(result.first())) : reply(404);
      }),
      operation('POST', '/tickets/{id}/touch', async ({ params }) => reply(200, await touchTicket(params.id))),
      operation('POST', '/tickets/{id}/close', async ({ params }) => {
        // One logged batch holding a lightweight transaction.
        await cassandra.batch([{ query: "UPDATE tickets SET status = 'closed' WHERE id = ? IF EXISTS", params: [params.id] }], { prepare: true });
        return reply(200, { id: params.id, status: 'closed' });
      }),
    );
    unavailableOperation('DELETE', '/tickets/{id}', ['cassandra'], async ({ params }) => {
      await cassandra.execute('DELETE FROM tickets WHERE id = ?', [params.id], { prepare: true });
      return reply(204);
    });
  }

  if (env.BENCH_OPENSEARCH_URL) {
    const [{ Client }, { opensearchStore }] = await Promise.all([import('@opensearch-project/opensearch'), import('@sendproof/elasticsearch')]);
    const search = new Client({ node: env.BENCH_OPENSEARCH_URL });
    dataStores.push(opensearchStore(search, { name: 'search' }));
    closers.push(() => search.close());
    const index = env.BENCH_OPENSEARCH_INDEX;
    const request = async (method, path, body) => (await search.transport.request({ method, path, ...(body === undefined ? {} : { body }) })).body;
    const article = (id, source) => ({ id, title: source.title ?? null, views: source.views ?? 0 });
    touchArticle = async id => {
      const result = await request('POST', `/${index}/_update/${encodeURIComponent(id)}?refresh=true`, {
        script: { source: 'ctx._source.views += params.step', params: { step: 1 } }, upsert: { title: 'Untitled', views: 1 }, _source: true,
      });
      return article(id, result.get?._source ?? {});
    };
    operations.push(
      operation('GET', '/articles/{id}', async ({ params }) => {
        // A read sent as a POST: the method alone must not decide.
        const result = await request('POST', `/${index}/_search`, { query: { ids: { values: [params.id] } }, size: 1 });
        const hit = result.hits?.hits?.[0];
        return hit ? reply(200, article(hit._id, hit._source)) : reply(404);
      }),
      operation('POST', '/articles/{id}/touch', async ({ params }) => reply(200, await touchArticle(params.id))),
      operation('POST', '/articles/{id}/hide', async ({ params }) => {
        // Store errors are swallowed on purpose: the blocked mark, not the response, decides a Preview.
        let result = null;
        try {
          result = await request('POST', `/${index}/_update_by_query?refresh=true`, {
            query: { ids: { values: [params.id] } }, script: { source: 'ctx._source.hidden = true' },
          });
        } catch { /* reported as not found */ }
        return result?.updated ? reply(200, { id: params.id, hidden: true }) : reply(404);
      }),
    );
    unavailableOperation('DELETE', '/articles/{id}', ['opensearch'], async ({ params }) => {
      await request('DELETE', `/${index}/_doc/${encodeURIComponent(params.id)}?refresh=true`);
      return reply(204);
    });
  }

  if (redis || dynamo || touchTicket || touchArticle) {
    operations.push(operation('POST', '/items/{id}/remember', async ({ params, body, query }) => {
      if (!text(body?.name)) return reply(400);
      const store = query.get('store');
      const writers = {
        redis: redis && (() => redis.incr(`${env.BENCH_REDIS_PREFIX ?? ''}counter:item-${params.id}`)),
        dynamodb: dynamo && (() => touch('item-' + params.id)),
        cassandra: touchTicket && (() => touchTicket('item-' + params.id)),
        opensearch: touchArticle && (() => touchArticle('item-' + params.id)),
      };
      if (!writers[store]) return reply(400);
      await insertItem(params.id, body.name);
      await writers[store]();
      return reply(201, { id: params.id, name: body.name });
    }));
  }

  return { dataStores, operations, unavailable, close: () => Promise.allSettled(closers.map(close => close())) };
}
