/**
 * Runs the shared classification vectors (spec/data-stores/classification-cases.json) against the
 * reference classifier. Each binding runs the same vectors in its own unit tests.
 *
 *   node --test tests/conformance/fixtures/data-stores-reference/classification.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { classifyDynamo, classifyMongo, classifyRedis } from './guard.mjs';

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
