import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequestEditor, requestExample } from "./request-editor.js";
import { newUuid } from "./uuid.js";

test("development origins generate an idempotency key when randomUUID is unavailable", () => {
  const crypto = { getRandomValues: bytes => bytes.fill(255) };
  assert.equal(newUuid(crypto), "ffffffff-ffff-4fff-bfff-ffffffffffff");
});

test("sample resolves media and parameter examples, including on the JSON tab", async () => {
  const document = {
    components: { examples: { Example: { value: { amount: 42 } } } },
  };
  const state = {
    doc: document,
    forms: [],
    tab: "JSON",
    op: {
      title: "Create",
      method: "POST",
      path: "/things",
      group: "Things",
      operation: {
        requestBody: {
          content: {
            "application/json": {
              schema: { type: "object" },
              examples: { seeded: { $ref: "#/components/examples/Example" } },
            },
          },
        },
      },
      parameters: [
        { in: "header", name: "Idempotency-Key", schema: { type: "string" } },
        {
          in: "header",
          name: "X-Example",
          schema: { type: "string" },
          example: "sample-header",
        },
      ],
    },
  };
  const nodes = new Map();
  const $ = (selector) => {
    if (!nodes.has(selector))
      nodes.set(selector, { innerHTML: "", addEventListener() {}, setAttribute() {} });
    return nodes.get(selector);
  };
  const editor = createRequestEditor({
    state,
    basePath: "/",
    $,
    updateSnippet() {},
  });
  await editor.fillSample();
  assert.deepEqual(state.body, { amount: 42 });
  assert.equal(state.paramValues["header:X-Example"], "sample-header");
  assert.equal(requestExample({ example: false }, document), false);
  globalThis.location = new URL("https://example.test/bench/");
  const request = editor.readRequest();
  const idempotencyKey = request.headers.get("Idempotency-Key");
  assert.match(idempotencyKey, /^[0-9a-f-]{36}$/i);
  await editor.fillSample();
  assert.equal(editor.readRequest().headers.get("Idempotency-Key"), idempotencyKey);
  assert.equal(request.headers.get("X-Example"), "sample-header");
  assert.deepEqual(JSON.parse(request.body), { amount: 42 });
});

test("custom header rows are carried into the prepared request", () => {
  const state = {
    doc: {},
    forms: [],
    tab: "Form",
    headers: [{ id: "custom-1", name: "X-Trace", value: "trace-123" }],
    op: {
      title: "Inspect",
      method: "GET",
      path: "/things",
      group: "Things",
      operation: {},
      parameters: [],
    },
  };
  const $ = () => ({ innerHTML: "", addEventListener() {}, setAttribute() {} });
  const editor = createRequestEditor({ state, basePath: "/", $, updateSnippet() {} });
  const request = editor.readRequest();
  assert.equal(request.headers.get("X-Trace"), "trace-123");
});

test("schema validation errors expose linkable issues", () => {
  const state = {
    doc: {},
    forms: [{
      validate: () => ({ valid: false, errors: [{ path: "email", message: "Enter a valid email address." }] }),
      getValue: () => ({ email: "kk" })
    }],
    tab: "Form",
    headers: [],
    op: { method: "POST", path: "/login", operation: {}, parameters: [] }
  };
  const editor = createRequestEditor({ state, basePath: "/", $: () => ({ innerHTML: "", addEventListener() {}, setAttribute() {} }), updateSnippet() {} });
  assert.throws(() => editor.readRequest(), error => {
    assert.equal(error.validation, true);
    assert.deepEqual(error.issues, [{ path: "email", message: "Enter a valid email address." }]);
    return true;
  });
});

test("raw JSON validates body formats and types before preparing a request", () => {
  const state = {
    doc: {},
    forms: [],
    tab: "JSON",
    json: JSON.stringify({ email: "kk", amount: "g" }),
    headers: [],
    op: {
      method: "POST",
      path: "/payments",
      operation: { requestBody: { required: false, content: { "application/json": {
        schema: { type: "object", properties: {
          email: { type: "string", format: "email" }, amount: { type: "number" }
        } }
      } } } },
      parameters: []
    }
  };
  const editor = createRequestEditor({ state, basePath: "/", $: () => ({ innerHTML: "", addEventListener() {}, setAttribute() {} }), updateSnippet() {} });
  assert.throws(() => editor.readRequest(), error => {
    assert.deepEqual(error.issues.map(issue => issue.path), ["email", "amount"]);
    return true;
  });
});
