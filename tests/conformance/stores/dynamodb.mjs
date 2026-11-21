/**
 * A minimal DynamoDB client for the conformance runner and the data-store reference fixture.
 *
 * DynamoDB's API is JSON over HTTP POST with the operation in `X-Amz-Target`, signed with AWS
 * Signature Version 4. DynamoDB Local accepts any well-formed signature, but this client signs
 * correctly so the same code works against a real endpoint. It has no SDK dependency, so the runner
 * can read tables independently of the binding under test.
 */
import { createHash, createHmac } from 'node:crypto';

const sha256 = data => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

/** A DynamoDB error response, carrying the AWS error type such as `ConditionalCheckFailedException`. */
export class DynamoError extends Error {
  constructor(type, message) {
    super(`${type}: ${message}`);
    this.type = type;
  }
}

/**
 * Creates a client for `endpoint` (for example `http://127.0.0.1:58000`).
 * `call('GetItem', { TableName, Key })` posts one operation and resolves with the parsed JSON reply.
 */
export function dynamoClient({ endpoint, region = 'us-east-1', accessKeyId, secretAccessKey }) {
  const url = new URL(endpoint);
  async function call(operation, input) {
    const body = JSON.stringify(input);
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const day = amzDate.slice(0, 8);
    const headers = {
      'content-type': 'application/x-amz-json-1.0',
      host: url.host,
      'x-amz-date': amzDate,
      'x-amz-target': 'DynamoDB_20120810.' + operation,
    };
    const signed = Object.keys(headers).sort();
    // Method, path, empty query, the canonical headers (each line ends in a newline), signed names, body hash.
    const canonicalHeaders = signed.map(name => `${name}:${headers[name]}\n`).join('');
    const canonical = ['POST', url.pathname || '/', '', canonicalHeaders, signed.join(';'), sha256(body)].join('\n');
    const scope = `${day}/${region}/dynamodb/aws4_request`;
    const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
    const key = ['dynamodb', 'aws4_request'].reduce(hmac, hmac(hmac('AWS4' + secretAccessKey, day), region));
    const signature = createHmac('sha256', key).update(toSign).digest('hex');
    const response = await fetch(url, {
      method: 'POST', body, signal: AbortSignal.timeout(10000),
      headers: {
        ...headers,
        authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signed.join(';')}, Signature=${signature}`,
      },
    });
    const reply = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new DynamoError(String(reply.__type ?? response.status).split('#').pop(), reply.message ?? reply.Message ?? '');
    }
    return reply;
  }
  return { call };
}

/** Converts a plain object of strings and numbers to DynamoDB attribute values. */
export function toItem(object) {
  return Object.fromEntries(Object.entries(object).map(([name, value]) =>
    [name, typeof value === 'number' ? { N: String(value) } : { S: String(value) }]));
}

/** Converts DynamoDB attribute values (S, N, BOOL, NULL) back to a plain object. */
export function fromItem(item) {
  if (!item) return null;
  return Object.fromEntries(Object.entries(item).map(([name, value]) => {
    if ('S' in value) return [name, value.S];
    if ('N' in value) return [name, Number(value.N)];
    if ('BOOL' in value) return [name, value.BOOL];
    if ('NULL' in value) return [name, null];
    return [name, value];
  }));
}
