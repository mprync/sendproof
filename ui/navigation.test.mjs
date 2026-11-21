import { test } from "node:test";
import assert from "node:assert/strict";
import { createNavigation } from "./navigation.js";

test("palette groups entries, opens models, and restores history without running it", async () => {
  const events = {};
  const input = {
    value: "",
    hidden: false,
    setAttribute() {},
    removeAttribute() {},
    addEventListener(type, fn) {
      events[`input:${type}`] = fn;
    },
    focus() {},
  };
  const back = { focus() {} };
  const list = {
    innerHTML: "",
    setAttribute() {},
    removeAttribute() {},
    querySelector() {
      return back;
    },
  };
  const dialog = {
    addEventListener(type, fn) {
      events[`dialog:${type}`] = fn;
    },
  };
  const overlay = {
    innerHTML: "",
    querySelector(selector) {
      return selector === "input"
        ? input
        : selector === ".pal-list"
          ? list
          : dialog;
    },
    querySelectorAll() {
      return [];
    },
  };
  globalThis.document = { activeElement: { focus() {} } };
  const op = {
    method: "POST",
    path: "/items",
    title: "Create item",
    operation: {},
  };
  const state = {
    cap: {},
    doc: {
      components: {
        schemas: {
          Item: { type: "object", properties: { name: { type: "string" } } },
        },
      },
    },
    ops: [op],
    history: [
      { op, body: { name: "saved" }, params: {}, preview: true, when: 0 },
    ],
  };
  let runs = 0,
    renders = 0,
    opened;
  const navigation = createNavigation({
    state,
    $: () => overlay,
    selectOperation() {},
    run() {
      runs++;
    },
    renderOperation() {
      renders++;
    },
    openModel(name) {
      opened = name;
    },
    commands: () => [
      { id: "signin", label: "Switch user", run() {} },
      { id: "copy-url", label: "Copy URL", run() {} },
    ],
  });
  navigation.palette();
  assert.match(list.innerHTML, /Operations/);
  assert.match(list.innerHTML, /Actions/);
  assert.match(list.innerHTML, /Models/);
  overlay.onclick({
    target: {
      closest(selector) {
        return selector === "[data-palette-index]"
          ? { dataset: { paletteIndex: "4" } }
          : null;
      },
    },
  });
  assert.equal(opened, "Item", "a model result opens its model page");
  input.value = "";
  input.hidden = false;
  navigation.palette();
  overlay.onclick({
    target: {
      closest(selector) {
        return selector === "[data-palette-index]"
          ? { dataset: { paletteIndex: "3" } }
          : null;
      },
    },
  });
  assert.equal(runs, 0);
  assert.equal(renders, 1);
  assert.deepEqual(state.body, { name: "saved" });
  input.value = "create item";
  input.hidden = false;
  navigation.palette();
  events["dialog:keydown"]({
    key: "Enter", metaKey: true, ctrlKey: false,
    preventDefault() {}, stopPropagation() {},
    target: { closest() { return null; } },
  });
  assert.equal(runs, 1);
});
