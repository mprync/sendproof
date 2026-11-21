/**
 * A minimal OpenSearch (and Elasticsearch) client for the conformance runner and the data-store
 * reference fixture: one JSON request per call over fetch, with NDJSON for bulk-style bodies. It is
 * the runner's independent reader: it shares nothing with the fixture under test.
 */

/**
 * Returns `{ request(method, path, body?) }` for a server URL such as http://127.0.0.1:59200.
 * `body` is an object (sent as JSON) or an array of objects (sent as NDJSON). The call resolves to
 * `{ status, body }` for every HTTP status; it rejects only when the server can't be reached.
 */
export function openSearchClient(url) {
  const origin = String(url).replace(/\/+$/, '');
  return {
    async request(method, path, body) {
      const ndjson = Array.isArray(body);
      const response = await fetch(origin + path, {
        method,
        headers: body === undefined ? {} : { 'Content-Type': ndjson ? 'application/x-ndjson' : 'application/json' },
        body: body === undefined ? undefined : ndjson ? body.map(line => JSON.stringify(line)).join('\n') + '\n' : JSON.stringify(body),
      });
      const text = await response.text();
      let parsed = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
      return { status: response.status, body: parsed };
    },
  };
}
