import { test } from "node:test";
import assert from "node:assert/strict";
import { clampTrack, keyboardTrackValue } from "./layout.js";

test("splitter values stay inside responsive track bounds", () => {
  assert.equal(clampTrack(120, 240, 640), 240);
  assert.equal(clampTrack(720, 240, 640), 640);
  assert.equal(clampTrack(420, 240, 640), 420);
  assert.equal(clampTrack(180, 240, 180), 240);
});

test("splitter keyboard controls support steps and edge jumps", () => {
  assert.equal(keyboardTrackValue(320, "ArrowRight", 240, 640, 16), 336);
  assert.equal(keyboardTrackValue(320, "ArrowLeft", 240, 640, 16), 304);
  assert.equal(keyboardTrackValue(320, "PageDown", 240, 640, 16), 384);
  assert.equal(keyboardTrackValue(320, "PageUp", 240, 640, 16), 256);
  assert.equal(keyboardTrackValue(320, "Home", 240, 640, 16), 240);
  assert.equal(keyboardTrackValue(320, "End", 240, 640, 16), 640);
});

test("splitter controls update the functional DOM and pointer drag state", async () => {
  const { createLayout } = await import("./layout.js");
  const documentListeners = new Map();
  const documentStub = {
    documentElement: {},
    body: { classList: { add() {}, remove() {} } },
    addEventListener(type, listener) {
      documentListeners.set(type, listener);
    },
    removeEventListener(type) {
      documentListeners.delete(type);
    },
  };
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const originalComputedStyle = globalThis.getComputedStyle;
  const originalResizeObserver = globalThis.ResizeObserver;
  try {
    globalThis.document = documentStub;
    globalThis.window = {
      matchMedia: () => ({ matches: true }),
      addEventListener() {},
      removeEventListener() {},
    };
    globalThis.getComputedStyle = () => ({ fontSize: "16px" });
    globalThis.ResizeObserver = undefined;

    const values = { sidebar: 264, request: 468 };
    const style = {
      setProperty(name, value) {
        if (name === "--sidebar-width") values.sidebar = Number.parseFloat(value);
        if (name === "--request-width") values.request = Number.parseFloat(value);
      },
    };
    const makeHandle = (type) => {
      const listeners = new Map();
      return {
        dataset: { layoutDivider: type },
        attributes: {},
        addEventListener(name, listener) { listeners.set(name, listener); },
        removeEventListener(name) { listeners.delete(name); },
        setAttribute(name, value) { this.attributes[name] = value; },
        dispatch(name, event = {}) {
          listeners.get(name)?.({ currentTarget: this, ...event });
        },
      };
    };
    const handles = [makeHandle("sidebar"), makeHandle("request")];
    const workspace = {
      style,
      querySelectorAll: () => handles,
      querySelector(selector) {
        if (selector === ".sidebar") return { getBoundingClientRect: () => ({ width: values.sidebar }) };
        if (selector === ":scope > .pane:not([hidden])") return { getBoundingClientRect: () => ({ width: values.request }) };
        return null;
      },
      getBoundingClientRect: () => ({ left: 0, width: 1200 }),
    };

    const layout = createLayout(workspace);
    handles[0].dispatch("keydown", { key: "ArrowLeft", preventDefault() {} });
    assert.equal(values.sidebar, 248);
    assert.equal(handles[0].attributes["aria-valuenow"], "248");
    handles[1].dispatch("keydown", { key: "End", preventDefault() {} });
    assert.equal(values.request, 652);
    handles[0].dispatch("pointerdown", { button: 0, preventDefault() {} });
    documentListeners.get("pointermove")?.({ clientX: 280, preventDefault() {} });
    assert.equal(values.sidebar, 280);
    documentListeners.get("pointerup")?.();
    layout.destroy();
  } finally {
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
    globalThis.getComputedStyle = originalComputedStyle;
    globalThis.ResizeObserver = originalResizeObserver;
  }
});
