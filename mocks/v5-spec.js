// v5 (?v5=1): flags the page for the v5 design and loads its stylesheet.
//
// The spec changes the v5 design relies on (x-replaced-by and x-sunset on the deprecated
// operation, x-enum-descriptions on enums, inline enums and the sort parameter) are no longer
// patched in here: examples/TreasuryApi emits them and tools/mock-spec.mjs snapshots them into
// spec.js (see docs/plans/workbench-v5.md, section 10).
//
// Loads after spec.js and before schema.js.
(function () {
  const q = new URLSearchParams(location.search);
  if (!q.get('v5')) return;
  document.documentElement.dataset.v5 = '';
  // v5.css loads only with ?v5=1, so workbench.html keeps loading just the two shared
  // stylesheets (tests/ui/mock-styles.test.mjs) and the v3 and v4 screens are untouched.
  // document.write keeps it parser-inserted, so the scripts after this one wait for it and
  // every pane and popover is measured with the v5 styles applied.
  if (!document.querySelector('link[href="v5.css"]')) document.write('<link rel="stylesheet" href="v5.css">');
  // A response that doesn't match its schema, for the mismatch screens: a 3-letter country,
  // a missing required property and one the spec doesn't document.
  const samples = window.TB_SAMPLES || {};
  const first = samples.accountsPage?.items?.[0];
  if (first) {
    samples.account = { ...first };
    const { bic, ...rest } = first;
    samples.accountMismatch = { ...rest, entityCountry: 'NLD', legacyCode: 'AMS-COL-01' };
  }
})();
