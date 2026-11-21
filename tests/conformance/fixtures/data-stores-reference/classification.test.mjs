/**
 * Runs the shared classification vectors (spec/data-stores/classification-cases.json) against the
 * reference classifier. Each binding runs the same vectors in its own unit tests.
 *
 *   node --test tests/conformance/fixtures/data-stores-reference/classification.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  classifyCassandra, classifyCassandraMessage, classifyCosmos, classifyDynamo, classifyElasticsearch, classifyFirestore, classifyMongo,
  classifyRedis, firestoreRpc,
} from './guard.mjs';

const cases = JSON.parse(readFileSync(new URL('../../../../spec/data-stores/classification-cases.json', import.meta.url), 'utf8'));

test('Redis classification', () => {
  for (const { command: [name, ...args], expect } of cases.redis) assert.equal(classifyRedis(name, args), expect, name);
});

test('MongoDB classification', () => {
  for (const { command, expect, refusedInTransaction } of cases.mongodb) {
    const result = classifyMongo(command);
    assert.equal(result.kind, expect, JSON.stringify(command));
    assert.equal(result.refusedInTransaction, refusedInTransaction, JSON.stringify(command));
  }
});

test('DynamoDB classification', () => {
  for (const { operation, input, expect } of cases.dynamodb) assert.equal(classifyDynamo(operation, input), expect, `${operation} ${JSON.stringify(input)}`);
});

// Batch two: each case also pins the db.operation.name the Db log entry and the 409 body use.
const check = (actual, { expect, operation }, label) => assert.deepEqual(actual, { kind: expect, operation }, label);

test('Cassandra classification', () => {
  for (const item of cases.cassandra) {
    const actual = item.message ? classifyCassandraMessage(item.message, item) : classifyCassandra(item.statement);
    check(actual, item, JSON.stringify(item));
  }
});

test('Elasticsearch and OpenSearch classification', () => {
  for (const item of cases.elasticsearch) check(classifyElasticsearch(item.method, item.path, item.body), item, `${item.method} ${item.path}`);
});

test('Cosmos DB classification', () => {
  for (const item of cases.cosmosdb) check(classifyCosmos(item), item, JSON.stringify(item));
});

test('Firestore classification', () => {
  for (const item of cases.firestore) {
    const actual = item.rest ? classifyFirestore(firestoreRpc(item.rest), item.rest.body) : classifyFirestore(item.rpc, item.message);
    check(actual, item, JSON.stringify(item));
  }
});

test('Every batch-two store has cases for each kind it classifies', () => {
  for (const store of ['cassandra', 'elasticsearch', 'cosmosdb', 'firestore']) {
    const kinds = new Set(cases[store].map(item => item.expect));
    assert(kinds.has('read') && kinds.has('write'), `${store} needs read and write cases`);
  }
});
