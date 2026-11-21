import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitCrumbs } from './crumb-fit.js';

// A stand-in DOM: each earlier crumb is an <li> holding a link whose text is `width` px wide,
// with the link's 0.2rem (3.2px) padding and negative margin on both sides.
const crumb = (width, shown = true) => {
  const props = new Map();
  const link = { _width: width };
  return {
    firstElementChild: link, style: { setProperty: (name, value) => props.set(name, value), removeProperty: name => props.delete(name) },
    getClientRects: () => (shown ? [{}] : []), props,
  };
};

function withDom(items, run) {
  const originals = { document: globalThis.document, getComputedStyle: globalThis.getComputedStyle };
  globalThis.document = { createRange: () => {
    let node;
    return { selectNodeContents: target => { node = target; }, getBoundingClientRect: () => ({ width: node._width }) };
  } };
  globalThis.getComputedStyle = () => ({ paddingInlineStart: '3.2px', paddingInlineEnd: '3.2px', marginInlineStart: '-3.2px', marginInlineEnd: '-3.2px' });
  try { run({ querySelectorAll: () => items }); } finally {
    for (const [name, value] of Object.entries(originals)) { if (value === undefined) delete globalThis[name]; else globalThis[name] = value; }
  }
}

test('each shown earlier crumb gets its natural width, rounded up, as --nat', () => {
  const short = crumb(44.2), long = crumb(131);
  withDom([short, long], root => fitCrumbs(root));
  assert.equal(short.props.get('--nat'), '45px', 'padding and negative margin cancel; the text width rounds up');
  assert.equal(long.props.get('--nat'), '131px');
});

test('a hidden crumb (a phone shows only the page) loses its measurement', () => {
  const hidden = crumb(50, false);
  hidden.props.set('--nat', '50px');
  withDom([hidden], root => fitCrumbs(root));
  assert.equal(hidden.props.has('--nat'), false);
});
