// DynamoDB write guard (`@sendproof/dynamodb`) against DynamoDB Local from the compose file, for
// the base client and the document client. An independent, unhooked client reads the table after
// every Preview, so a passing check proves the refused request was never sent.
import assert from 'node:assert/strict';
import test from 'node:test';
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient, ExecuteStatementCommand, GetItemCommand, PutItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { dynamoStore, sanitizePartiql } from '@sendproof/dynamodb';
import { assertBlocked, dbEntries, fresh, handle, needs, services, startApp } from './support/stores.mts';

const secret = 'benchDynamoSecret' + Math.random().toString(16).slice(2);
const config = { endpoint: services.dynamodb, region: 'us-east-1', credentials: { accessKeyId: 'benchlocal', secretAccessKey: secret } };

/** A fresh table with string partition key `id`, removed when the test ends. */
async function table(t: test.TestContext) {
  const admin = new DynamoDBClient(config);
  const name = fresh('dynamo');
  await admin.send(new CreateTableCommand({
    TableName: name, BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }], KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
  }));
  t.after(async () => { await admin.send(new DeleteTableCommand({ TableName: name })); admin.destroy(); });
  await admin.send(new PutItemCommand({ TableName: name, Item: { id: { S: 'seeded' }, status: { S: 'open' }, hits: { N: '3' } } }));
  const read = async (id: string) => (await admin.send(new GetItemCommand({ TableName: name, Key: { id: { S: id } }, ConsistentRead: true }))).Item;
  return { name, read };
}

async function app(t: test.TestContext, hook = true) {
  const { name, read } = await table(t);
  const client = new DynamoDBClient(config);
  const documents = DynamoDBDocumentClient.from(client);
  t.after(() => client.destroy());
  // The document client shares the base client's stack: hooking the document client covers both.
  const store = hook ? dynamoStore(documents, { name: 'orders' }) : undefined;
  const touch = (id: string) => client.send(new UpdateItemCommand({
    TableName: name, Key: { id: { S: id } }, UpdateExpression: 'ADD hits :one SET #s = if_not_exists(#s, :new)',
    ExpressionAttributeNames: { '#s': 'status' }, ExpressionAttributeValues: { ':one': { N: '1' }, ':new': { S: 'new' } }, ReturnValues: 'ALL_NEW',
  }));
  const harness = await startApp(t, store ? [store] : [], bench => {
    bench.operation('GET', '/orders/{id}', handle(async (req, res) => {
      const { Item } = await documents.send(new GetCommand({ TableName: name, Key: { id: req.params.id }, ConsistentRead: true }));
      if (Item) res.json(Item); else res.status(404).end();
    }));
    bench.operation('POST', '/orders/{id}/touch', handle(async (req, res) => {
      res.json((await touch(req.params.id as string)).Attributes);
    }));
    bench.operation('POST', '/orders/{id}/rename', handle(async (req, res) => {
      // Swallowed on purpose: the blocked mark, not the response, decides the Preview.
      try {
        await documents.send(new UpdateCommand({ TableName: name, Key: { id: req.params.id }, UpdateExpression: 'SET #s = :s', ExpressionAttributeNames: { '#s': 'status' }, ExpressionAttributeValues: { ':s': 'renamed' } }));
      } catch { /* ignored */ }
      res.json({ ok: true });
    }));
    bench.operation('POST', '/orders/{id}/cancel', handle(async (req, res) => {
      await client.send(new ExecuteStatementCommand({ Statement: `UPDATE "${name}" SET status = 'cancelled' WHERE id = ?`, Parameters: [{ S: req.params.id as string }] }));
      res.json({ ok: true });
    }));
    bench.operation('GET', '/orders/{id}/select', handle(async (req, res) => {
      const { Items } = await client.send(new ExecuteStatementCommand({ Statement: `/* read */ SELECT * FROM "${name}" WHERE id = ?`, Parameters: [{ S: req.params.id as string }] }));
      res.json({ count: Items?.length ?? 0 });
    }));
    bench.operation('GET', '/orders/{id}/inline', handle(async (req, res) => {
      // A value written into the statement instead of a parameter.
      const { Items } = await client.send(new ExecuteStatementCommand({ Statement: `SELECT * FROM "${name}" WHERE id = '${req.params.id}' AND hits < 1000` }));
      res.json({ count: Items?.length ?? 0 });
    }));
  });
  return { ...harness, read };
}

async function guardChecks(t: test.TestContext, hook = true) {
  const { preview, read } = await app(t, hook);
  await assertBlocked(await preview('POST', '/orders/blocked/touch'), 'dynamodb', 'UpdateItem');
  assert.equal(await read('blocked'), undefined, 'UpdateItem must not reach DynamoDB');
  await assertBlocked(await preview('POST', '/orders/seeded/rename'), 'dynamodb', 'UpdateItem');
  await assertBlocked(await preview('POST', '/orders/seeded/cancel'), 'dynamodb', 'ExecuteStatement');
  assert.equal((await read('seeded'))?.status?.S, 'open', 'Neither the document-client update nor the PartiQL UPDATE may reach DynamoDB');
}

test('DynamoDB reads, including PartiQL SELECT, run in Preview and are logged', await needs('dynamodb'), async t => {
  const { confirmed } = await app(t);
  const envelope = await confirmed('GET', '/orders/seeded');
  assert.deepEqual(envelope.body, { id: 'seeded', status: 'open', hits: 3 });
  const [entry] = dbEntries(envelope.logs, 'dynamodb', 'GetItem');
  assert(entry, 'Expected a Db entry for GetItem');
  assert.match(entry.db.target, /^tb_dynamo_/);
  assert.equal(entry.db.rowsAffected, 1);
  const select = await confirmed('GET', '/orders/seeded/select');
  assert.deepEqual(select.body, { count: 1 });
  assert.match(dbEntries(select.logs, 'dynamodb', 'ExecuteStatement')[0].db.statement, /SELECT \* FROM/);
  const inline = await confirmed('GET', '/orders/seeded/inline');
  assert.deepEqual(inline.body, { count: 1 });
  const [statement] = dbEntries(inline.logs, 'dynamodb', 'ExecuteStatement').map(item => item.db.statement);
  assert.match(statement, /WHERE id = \? AND hits < \?$/);
  assert(!JSON.stringify(inline.logs).includes("'seeded'"), 'An inline literal must never reach a Db entry');
});

test('DynamoDB writes from either client are refused before the request is sent', await needs('dynamodb'), async t => {
  await guardChecks(t);
});

test('the DynamoDB guard checks fail without the hook', await needs('dynamodb'), async t => {
  await assert.rejects(guardChecks(t, false), assert.AssertionError);
});

test('DynamoDB observed Send commits once and never captures credentials', await needs('dynamodb'), async t => {
  const { observed, read } = await app(t);
  const { status, trace } = await observed('POST', '/orders/sent/touch');
  assert.equal(status, 200);
  assert.equal((await read('sent'))?.hits?.N, '1');
  assert.equal(dbEntries(trace.logs, 'dynamodb', 'UpdateItem').length, 1);
  const text = JSON.stringify(trace);
  assert(!text.includes(secret) && !text.includes('AWS4-HMAC-SHA256'), 'Credentials and signatures must never reach a trace');
});

test('a DynamoDB client is hooked once', () => {
  const client = new DynamoDBClient(config);
  dynamoStore(client);
  assert.throws(() => dynamoStore(DynamoDBDocumentClient.from(client)), /already hooked/);
  assert.throws(() => dynamoStore({ middlewareStack: null }), TypeError);
  client.destroy();
});

test('PartiQL statements in Db entries never carry inline literals', () => {
  assert.equal(sanitizePartiql(`UPDATE "orders2" SET "password" = 'it''s secret', hits = 42 WHERE id = ? AND n > -1.5e3`),
    `UPDATE "orders2" SET "password" = ?, hits = ? WHERE id = ? AND n > -?`);
  assert.equal(sanitizePartiql(`INSERT INTO "t" VALUE {'id': 'a', 'token': 'abc', 'n': 7}`), `INSERT INTO "t" VALUE {?: ?, ?: ?, ?: ?}`);
  assert.equal(sanitizePartiql(`SELECT * FROM "t" WHERE id = 'unterminated`), `SELECT * FROM "t" WHERE id = ?`);
});
