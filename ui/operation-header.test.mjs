import { test } from "node:test";
import assert from "node:assert/strict";
import { metaPills } from "./operation-header.js";

const document = { components: { securitySchemes: { cookieAuth: { type: "apiKey", in: "cookie", name: "session" } } }, security: [{ cookieAuth: [] }] };
const op = {
  method: "get", path: "/balances/{id}", parameters: [],
  operation: { responses: { 404: { description: "No account has this ID." }, 200: { description: "The balance. More text." }, 401: { description: "Not signed in." }, default: { description: "Error" } } },
};

test("status codes are separate segments in their class's hue, with the description as the tooltip", () => {
  const html = metaPills(op, document, true);
  assert.match(html, /<span class="sc sc-ok" title="200 · The balance\. More text\."><i aria-hidden="true"><\/i>200<\/span>/);
  assert.match(html, /class="sc sc-warn" title="401 · Not signed in\."/);
  assert.match(html, /class="sc sc-warn" title="404 · No account has this ID\."/);
  // Sorted, and only numeric codes.
  assert.ok(html.indexOf(">200<") < html.indexOf(">401<") && html.indexOf(">401<") < html.indexOf(">404<"));
  assert.doesNotMatch(html, /default/);
});

test("a single documented code still shows", () => {
  const html = metaPills({ ...op, operation: { responses: { 204: { description: "Done." } } } }, document, true);
  assert.match(html, /class="sc sc-ok"[^>]*>.*204/);
});

test("the access pill says whether the current user can call the operation", () => {
  assert.match(metaPills(op, document, true), /class="pill access is-met"/);
  assert.match(metaPills(op, document, false), /class="pill access is-locked"/);
  assert.match(metaPills({ ...op, operation: { ...op.operation, security: [] } }, document, false), /class="pill access is-public"/);
});
