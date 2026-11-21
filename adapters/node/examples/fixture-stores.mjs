/**
 * Data-store routes of the conformance fixture (spec/conformance/fixture.md "Data store routes").
 *
 * Each store is hooked only when the runner passes its variables, so the standard and alternate
 * scenarios run without any store service. The routes use the clients exactly as an application
 * would: MongoDB through `mongoStore(...).client`, Redis through the hooked ioredis client and
 * DynamoDB through the hooked AWS SDK client.
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

  if (redis || dynamo) {
    operations.push(operation('POST', '/items/{id}/remember', async ({ params, body, query }) => {
      if (!text(body?.name)) return reply(400);
      const store = query.get('store');
      if (store !== 'redis' && store !== 'dynamodb') return reply(400);
      await insertItem(params.id, body.name);
      if (store === 'redis') await redis.incr(`${env.BENCH_REDIS_PREFIX ?? ''}counter:item-${params.id}`);
      else await touch('item-' + params.id);
      return reply(201, { id: params.id, name: body.name });
    }));
  }

  return { dataStores, operations, unavailable, close: () => Promise.allSettled(closers.map(close => close())) };
}
