// Batch-two classification (spec/data-stores.md "Batch two stores"): the embedded tables against
// spec/data-stores/ and every shared vector for Cassandra, Elasticsearch and OpenSearch, Cosmos DB
// and Firestore through the core classifiers.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cassandraTable, classifyCassandra, classifyCassandraMessage, classifyCosmos, classifyElasticsearch, classifyFirestore, cosmosdbTable,
  cosmosOperation, elasticsearchTable, firestoreRpc, firestoreTable, sanitizeStatement, storeName,
} from '@sendproof/core';
import { cases, specTable } from './support/stores.mts';

test('embedded batch-two tables match spec/data-stores', () => {
  // Regenerate with `npm run embed-store-tables --workspace @sendproof/core` when this fails.
  assert.deepEqual(cassandraTable, specTable('cassandra'));
  assert.deepEqual(elasticsearchTable, specTable('elasticsearch'));
  assert.deepEqual(cosmosdbTable, specTable('cosmosdb'));
  assert.deepEqual(firestoreTable, specTable('firestore'));
});

test('every shared Cassandra vector classifies as the spec says', () => {
  assert(cases.cassandra.length >= 30);
  for (const item of cases.cassandra) {
    const result = item.message === undefined
      ? classifyCassandra(item.statement)
      : classifyCassandraMessage(item.message, { statement: item.statement, prepared: item.prepared });
    assert.deepEqual(result, { kind: item.expect, operation: item.operation }, JSON.stringify(item));
  }
});

test('every shared Elasticsearch and OpenSearch vector classifies as the spec says', () => {
  assert(cases.elasticsearch.length >= 60);
  for (const item of cases.elasticsearch) {
    assert.deepEqual(classifyElasticsearch(item.method, item.path, item.body), { kind: item.expect, operation: item.operation }, JSON.stringify(item));
  }
});

test('every shared Cosmos DB vector classifies as the spec says', () => {
  assert(cases.cosmosdb.length >= 35);
  for (const item of cases.cosmosdb) {
    const result = item.request
      ? classifyCosmos({ request: item.request })
      : classifyCosmos({ operationType: item.operationType, triggers: item.triggers });
    assert.deepEqual(result, { kind: item.expect, operation: item.operation }, JSON.stringify(item));
  }
});

test('every shared Firestore vector classifies as the spec says', () => {
  assert(cases.firestore.length >= 35);
  for (const item of cases.firestore) {
    const result = item.rest
      ? classifyFirestore(firestoreRpc(item.rest), item.rest.body)
      : classifyFirestore(item.rpc, item.message);
    assert.deepEqual(result, { kind: item.expect, operation: item.operation }, JSON.stringify(item));
  }
});

test('host-declared reads match exact operation names only', () => {
  const reads = new Set(['FUTURESTATEMENT', 'POST /{}/_future_endpoint', 'FutureOperation', 'FutureMethod']);
  assert.equal(classifyCassandra('FUTURESTATEMENT t', reads).kind, 'read');
  assert.equal(classifyCassandra('FUTURESTATEMENTS t', reads).kind, 'write');
  assert.equal(classifyElasticsearch('POST', '/articles/_future_endpoint', undefined, reads).kind, 'read');
  assert.equal(classifyElasticsearch('POST', '/articles/_future_endpoints', undefined, reads).kind, 'write');
  assert.equal(classifyCosmos({ operationType: 'FutureOperation' }, reads).kind, 'read');
  assert.equal(classifyFirestore('/google.firestore.v1.Firestore/FutureMethod', undefined, reads).kind, 'read');
  // A host read never lets a batch, a trigger or a refused statement through unless its exact name is listed.
  assert.equal(classifyCassandra('BEGIN BATCH APPLY BATCH', reads).kind, 'write');
  assert.equal(classifyCosmos({ operationType: 'Read', triggers: true }, new Set(['Create'])).kind, 'write');
});

test('Cassandra text the table cannot read is a write, even when it starts with SELECT', () => {
  for (const text of ["SELECT * FROM t WHERE a = 'x", 'SELECT * FROM t; SELECT * FROM u', '/* open SELECT 1', 'SELECT $$ open']) {
    assert.equal(classifyCassandra(text).kind, 'write', text);
  }
  for (const value of [undefined, null, 42, {}, ['SELECT 1']]) assert.equal(classifyCassandra(value).kind, 'write');
});

test('Elasticsearch SQL bodies are read only when one read statement or a cursor page', () => {
  const sql = (body: unknown) => classifyElasticsearch('POST', '/_plugins/_sql', body).kind;
  assert.equal(sql({ query: 'SELECT 1' }), 'read');
  assert.equal(sql(Buffer.from('{"query":"show tables"}')), 'read');
  assert.equal(sql({ query: 'DELETE FROM a' }), 'write');
  assert.equal(sql({ query: 'SELECT 1', cursor: 'x' }), 'read');
  assert.equal(sql({ cursor: 'x' }), 'read');
  assert.equal(sql({ cursor: 7 }), 'write');
  assert.equal(sql(undefined), 'write');
  assert.equal(sql([{ query: 'SELECT 1' }]), 'write');
  // A body the guard can't read (a stream) fails closed.
  assert.equal(sql({ pipe() {} }), 'write');
});

test('Cosmos DB derives the operation from the request when the SDK type is missing or understates it', () => {
  assert.equal(cosmosOperation({ method: 'POST', path: '/dbs/a/colls/b/docs', headers: { 'X-MS-DOCUMENTDB-IS-UPSERT': 'True' } }), 'Upsert');
  // The SDK says read but the request is a write: either level is enough to refuse.
  assert.deepEqual(classifyCosmos({ operationType: 'read', request: { method: 'DELETE', path: '/dbs/a/colls/b/docs/c' } }), { kind: 'write', operation: 'Read' });
  assert.deepEqual(classifyCosmos({ operationType: 'read', request: { method: 'GET', path: '/dbs/a/colls/b/docs/c', headers: { 'x-ms-documentdb-pre-trigger-include': 't' } } }), { kind: 'write', operation: 'Read' });
  assert.deepEqual(classifyCosmos({ operationType: 'query', request: { method: 'POST', path: '/dbs/a/colls/b/docs', headers: { 'x-ms-documentdb-isquery': 'true' } } }), { kind: 'read', operation: 'Query' });
});

test('Firestore Commit is a write unless its message is readable and has no writes', () => {
  const commit = '/google.firestore.v1.Firestore/Commit';
  assert.equal(classifyFirestore(commit).kind, 'write');
  assert.equal(classifyFirestore(commit, null).kind, 'write');
  assert.equal(classifyFirestore(commit, { writes: [{}] }).kind, 'write');
  assert.equal(classifyFirestore(commit, { writes: [] }).kind, 'session');
  assert.equal(classifyFirestore(commit, { writes: 'x' }).kind, 'write');
});

test('literals in statements are replaced and the store names are display names', () => {
  assert.equal(sanitizeStatement(`INSERT INTO "My Table" (id, n) VALUES ('a''b', 42) -- x $$secret$$ ${'$$'}y${'$$'} 3.5e2`), `INSERT INTO "My Table" (id, n) VALUES (?, ?) -- x ? ? ?`);
  assert.equal(sanitizeStatement('SELECT * FROM t1 WHERE a = -7 AND b = @p'), 'SELECT * FROM t1 WHERE a = ? AND b = @p');
  // CQL blob and uuid/timeuuid literals are values too, and may hold tokens or hashes.
  assert.equal(sanitizeStatement('INSERT INTO s (id, token, hash) VALUES (123e4567-e89b-12d3-a456-426614174000, 0xCAFEBABE, 0x)'), 'INSERT INTO s (id, token, hash) VALUES (?, ?, ?)');
  assert.equal(sanitizeStatement('SELECT * FROM t2 WHERE id = ABCDEF01-2345-6789-abcd-ef0123456789'), 'SELECT * FROM t2 WHERE id = ?');
  assert.deepEqual(['cassandra', 'elasticsearch', 'opensearch', 'cosmosdb', 'firestore'].map(storeName), ['Cassandra', 'Elasticsearch', 'OpenSearch', 'Cosmos DB', 'Firestore']);
});
