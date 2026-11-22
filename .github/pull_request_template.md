## What changes

What changes for an API developer or a contributor. Link the issue if there is one.

## How it was checked

- [ ] The binding's own test suite
- [ ] `node tests/conformance/run.mjs <ids>` for the combinations this touches
- [ ] For UI changes: `node tools/browser-test.mjs`, `node tools/accessibility.mjs`, and before/after images at desktop and phone widths, light and dark
- [ ] For transaction, store or authentication changes: a test that proves nothing persists, or that access is still denied

## Notes for the reviewer

Anything deliberately left out, or a follow-up you plan.
