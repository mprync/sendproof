import { test } from "node:test";
import assert from "node:assert/strict";
import { createHeaderEditor } from "./header-editor.js";
import { formatRequest } from "./snippets.js";
import {
  coerceHeaderValue,
  createHeaderRow,
  formatHeaderLines,
  headerRowsToObject,
  normalizeHeaderRows,
  parseHeaderLines,
  validateHeaderRows,
} from "./headers.js";

test("normalizes legacy JSON objects into editable rows", () => {
  const rows = normalizeHeaderRows('{"X-Trace":"abc","Accept":"application/json"}');
  assert.deepEqual(rows.map(({ name, value }) => ({ name, value })), [
    { name: "X-Trace", value: "abc" },
    { name: "Accept", value: "application/json" },
  ]);
  assert.ok(rows.every((row) => row.id));
});

test("serializes enabled headers with fresh variables and retains the draft", () => {
  const rows = [
    createHeaderRow("X-Request-ID", "run-{{uuid}}"),
    createHeaderRow("X-Seen-At", "{{now}}"),
    createHeaderRow("X-Previous-ID", "{{last.id}}"),
    createHeaderRow("x-request-id", "{{missing}}", false),
  ];
  const now = "2026-11-20T10:00:00.000Z";
  let serial = 0;
  const context = { uuid: () => String(++serial), now, lastId: 42 };
  assert.deepEqual(headerRowsToObject(rows, context), {
    "X-Request-ID": "run-1",
    "X-Seen-At": now,
    "X-Previous-ID": "42",
  });
  assert.equal(headerRowsToObject(rows, context)["X-Request-ID"], "run-2");
  assert.equal(rows[0].value, "run-{{uuid}}");
  assert.throws(() => headerRowsToObject(rows, { now }), /Run a request that returns an id/);
});

test("bulk editing retains disabled headers and colons inside values", () => {
  const rows = [
    createHeaderRow("X-Callback", "https://example.test:8080/callback"),
    createHeaderRow("X-Trace", "{{uuid}}", false),
  ];
  assert.deepEqual(parseHeaderLines(formatHeaderLines(rows), rows), { rows, errors: [] });
  assert.deepEqual(parseHeaderLines("X-Trace: yes\nX-Invalid").errors, [
    "Line 2: add a colon after the header name.",
  ]);
});

test("the editor validates declared header schemas and prepares typed send parameters", () => {
  const key = { in: "header", name: "Idempotency-Key", required: true, schema: { type: "string", format: "uuid" } };
  const version = { in: "header", name: "X-Version", schema: { type: "integer", minimum: 1 } };
  const state = {
    cap: { identity: { name: "Ada Admin" } },
    doc: {},
    op: { parameters: [key, version] },
    paramValues: { "header:Idempotency-Key": "bad", "header:X-Version": "{{last.id}}" },
    headers: [createHeaderRow("X-Disabled", "no", false)],
    lastResponse: { body: { id: 42 } },
  };
  const editor = createHeaderEditor({ state, parameterSchema: parameter => parameter.schema, getMediaType: () => "application/json" });
  assert.deepEqual(editor.issues().map(issue => issue.inputId), ["declared-header-Idempotency-Key-value"]);
  state.paramValues["header:Idempotency-Key"] = "{{uuid}}";
  assert.deepEqual(editor.issues(), []);
  const [id, resolved] = editor.parameters();
  assert.match(id.value, /^[0-9a-f-]{36}$/i);
  assert.equal(resolved.value, 42);
  assert.equal(editor.count(), 4);
  assert.deepEqual(editor.values(), {});
});

test("rejects invalid, duplicate, and multiline headers", () => {
  const rows = [
    { id: "one", name: "X-Trace", value: "abc" },
    { id: "two", name: "x-trace", value: "duplicate" },
    { id: "three", name: "Not Valid", value: "ok" },
    { id: "four", name: "X-New", value: "line\nbreak" },
  ];
  const result = validateHeaderRows(rows);
  assert.equal(result.valid, false);
  assert.deepEqual(result.errors.map((error) => error.id), ["two", "three", "four"]);
  assert.throws(() => headerRowsToObject(rows), /Duplicate header name/);
});

test("allows empty values and preserves header names when building request extras", () => {
  const row = createHeaderRow("X-Empty", "");
  assert.deepEqual(headerRowsToObject([row]), { "X-Empty": "" });
  assert.equal(validateHeaderRows([row]).valid, true);
});

test("coerces declared scalar header values back to their schema types", () => {
  assert.equal(coerceHeaderValue("42", { type: "integer" }), 42);
  assert.equal(coerceHeaderValue("3.5", { type: "number" }), 3.5);
  assert.equal(coerceHeaderValue("false", { type: "boolean" }), false);
  assert.equal(coerceHeaderValue("ready", { enum: ["ready", "done"] }), "ready");
  assert.equal(coerceHeaderValue("", { type: "integer" }), undefined);
});

test("custom credential headers remain redacted in request snippets", () => {
  const snippet = formatRequest("curl", {
    method: "GET",
    url: "https://example.test/widgets",
    headers: { "X-Access-Token": "private-value", "X-Trace": "trace-123" },
  });
  assert.match(snippet, /X-Access-Token: REDACTED/i);
  assert.match(snippet, /X-Trace: trace-123/i);
});
