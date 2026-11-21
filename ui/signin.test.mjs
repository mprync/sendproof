import { test } from "node:test";
import assert from "node:assert/strict";
import { showSignIn } from "./signin.js";

class FakeElement {
  constructor() {
    this.events = {};
    this.attributes = {};
    this.value = "";
    this.type = "";
    this.disabled = false;
    this.textContent = "";
    this.innerHTML = "";
  }
  addEventListener(name, callback) { this.events[name] = callback; }
  setAttribute(name, value) { this.attributes[name] = value; }
  querySelector() { return this.submitButton; }
}

function fakeRoot() {
  const elements = Object.fromEntries(["#cancel-signin", "#auth-error", "#show-password", "#password", "#email", "#signin-form", "#personas"].map(id => [id, new FakeElement()]));
  elements["#password"].type = "password";
  elements["#signin-form"].submitButton = new FakeElement();
  return { innerHTML: "", elements, querySelector: id => elements[id] };
}

test("sign-in renders registered providers and submits credentials", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => [{ name: "Ada Admin", email: "ada@example.test", role: "admin" }] };
  };
  try {
    const root = fakeRoot();
    let signedIn = 0;
    await showSignIn(root, { apiName: "<API>", environment: "Development", authProviders: [
      { kind: "cookie", label: "Session", url: "/auth/login" },
      { kind: "personas", label: "People", url: "/auth/personas" },
      { kind: "oidc", label: "Microsoft Entra", url: "/challenge" },
      { kind: "apiKey", label: "API key", url: "/keys" }
    ] }, () => { signedIn++; }, () => {});
    assert.match(root.innerHTML, /&lt;API&gt;/);
    assert.match(root.innerHTML, /Also enabled/);
    assert.match(root.innerHTML, /g-ms/);
    assert.match(root.innerHTML, /Sign-in methods reported by the API/);
    assert.match(root.elements["#personas"].innerHTML, />AA<\/span>/);
    const toggle = root.elements["#show-password"];
    toggle.events.click({ currentTarget: toggle });
    assert.equal(root.elements["#password"].type, "text");
    assert.equal(toggle.attributes["aria-label"], "Hide password");
    root.elements["#email"].value = "ada@example.test";
    root.elements["#password"].value = "secret";
    const form = root.elements["#signin-form"];
    form.events.submit({ preventDefault() {}, currentTarget: form });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests[1].url, "/auth/login");
    assert.deepEqual(JSON.parse(requests[1].options.body), { email: "ada@example.test", password: "secret" });
    assert.equal(signedIn, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test("cancel aborts pending persona discovery and prevents late updates", async () => {
  const originalFetch = globalThis.fetch;
  let signal;
  let finish;
  globalThis.fetch = (_, options) => {
    signal = options.signal;
    return new Promise(resolve => { finish = resolve; });
  };
  try {
    const root = fakeRoot();
    let cancelled = false;
    const loading = showSignIn(root, { authProviders: [{ kind: "personas", label: "People", url: "/people" }] }, () => {}, () => { cancelled = true; });
    root.elements["#cancel-signin"].onclick();
    assert.equal(signal.aborted, true);
    assert.equal(cancelled, true);
    finish({ ok: true, json: async () => [{ name: "Late", email: "late@example.test" }] });
    await loading;
    assert.equal(root.elements["#personas"].innerHTML, "");
  } finally { globalThis.fetch = originalFetch; }
});
