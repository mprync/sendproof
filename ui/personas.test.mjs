import { test } from "node:test";
import assert from "node:assert/strict";
import { probePersonas, resolvePersonaAccess } from "./personas.js";
import { showSignIn } from "./signin.js";

const provider = { kind: "personas", label: "People", url: "/auth/personas" };
const capabilities = () => ({ apiName: "Treasury", authProviders: [{ kind: "cookie", label: "Session", url: "/auth/login" }, { ...provider }] });

/** Runs `body` with `fetch` answering `answer`, then restores the real one. */
async function withFetch(answer, body) {
  const original = globalThis.fetch;
  globalThis.fetch = async (...args) => (typeof answer === "function" ? answer(...args) : answer);
  try { return await body(); } finally { globalThis.fetch = original; }
}

test("the persona probe maps 401, 403 and 404 to refused", async () => {
  for (const status of [401, 403, 404]) {
    await withFetch({ ok: false, status }, async () => assert.equal(await probePersonas(provider), "refused", String(status)));
  }
});

test("the persona probe maps 200 to available", async () => {
  await withFetch({ ok: true, status: 200 }, async () => assert.equal(await probePersonas(provider), "available"));
});

test("the persona probe treats 5xx, a network error and a timeout as unknown", async () => {
  await withFetch({ ok: false, status: 500 }, async () => assert.equal(await probePersonas(provider), "unknown"));
  await withFetch(() => { throw new TypeError("network"); }, async () => assert.equal(await probePersonas(provider), "unknown"));
  await withFetch((_, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))),
    async () => assert.equal(await probePersonas(provider, { timeout: 5 }), "unknown"));
});

test("a refusal removes the personas provider and flags it; other answers keep it", async () => {
  await withFetch({ ok: false, status: 403 }, async () => {
    const result = await resolvePersonaAccess(capabilities());
    assert.deepEqual(result.authProviders.map(item => item.kind), ["cookie"]);
    assert.equal(result.personasRefused, true);
  });
  for (const answer of [{ ok: true, status: 200 }, { ok: false, status: 500 }]) {
    await withFetch(answer, async () => {
      const result = await resolvePersonaAccess(capabilities());
      assert.deepEqual(result.authProviders.map(item => item.kind), ["cookie", "personas"]);
      assert.equal(result.personasRefused, undefined);
    });
  }
});

test("without a personas provider nothing is requested", async () => {
  await withFetch(() => { throw new Error("must not fetch"); }, async () => {
    const plain = { authProviders: [{ kind: "cookie", url: "/auth/login" }] };
    assert.equal(await resolvePersonaAccess(plain), plain);
  });
});

class FakeElement {
  constructor(html = "") { this.innerHTML = html; this.attributes = {}; this.events = {}; this.removed = false; this.inserted = ""; }
  addEventListener(name, callback) { this.events[name] = callback; }
  setAttribute(name, value) { this.attributes[name] = value; }
  closest(selector) { return selector === ".persona-card" ? this.card : undefined; }
  insertAdjacentHTML(_, html) { this.inserted += html; }
  remove() { this.removed = true; }
}

function fakeRoot() {
  const card = new FakeElement();
  const personas = new FakeElement();
  personas.card = card;
  const elements = { "#cancel-signin": new FakeElement(), "#personas": personas };
  return { innerHTML: "", card, elements, querySelector: id => elements[id] };
}

test("sign-in swaps the seeded panel for a pointer to password sign-in on 403, with no error", async () => {
  await withFetch({ ok: false, status: 403 }, async () => {
    const root = fakeRoot();
    await showSignIn(root, capabilities(), () => {}, () => {});
    assert.equal(root.card.removed, true);
    assert.match(root.card.inserted, /persona-refused/);
    assert.match(root.card.inserted, /aren’t available from this address/);
    assert.equal(root.elements["#personas"].innerHTML, "");
  });
});

test("sign-in never renders the seeded panel when boot already found it refused", async () => {
  const refused = { ...capabilities(), personasRefused: true, authProviders: capabilities().authProviders.slice(0, 1) };
  await withFetch(() => { throw new Error("must not fetch"); }, async () => {
    const root = fakeRoot();
    await showSignIn(root, refused, () => {}, () => {});
    assert.doesNotMatch(root.innerHTML, /persona-card|Seeded accounts<\/strong>/);
    assert.match(root.innerHTML, /persona-refused/);
    assert.match(root.innerHTML, /id="signin-form"/);
  });
});

test("sign-in shows the seeded accounts on 200", async () => {
  await withFetch({ ok: true, status: 200, json: async () => [{ name: "Ada Admin", email: "ada@example.test", role: "admin" }] }, async () => {
    const root = fakeRoot();
    await showSignIn(root, capabilities(), () => {}, () => {});
    assert.match(root.innerHTML, /persona-card/);
    assert.doesNotMatch(root.innerHTML, /persona-refused/);
    assert.match(root.elements["#personas"].innerHTML, />AA<\/span>/);
    assert.equal(root.card.removed, false);
  });
});

test("sign-in keeps its error row for a 500 from the personas source", async () => {
  await withFetch({ ok: false, status: 500 }, async () => {
    const root = fakeRoot();
    await showSignIn(root, capabilities(), () => {}, () => {});
    assert.match(root.elements["#personas"].innerHTML, /role="alert"/);
    assert.match(root.elements["#personas"].innerHTML, /Couldn’t load the accounts \(500\)/);
    assert.equal(root.card.removed, false);
  });
});
