// v5 (?v5=1): flags the page for the v5 design and loads its stylesheet.
//
// The spec changes the v5 design relies on (x-replaced-by and x-sunset on the deprecated
// operation, x-enum-descriptions on enums, inline enums and the sort parameter) live in
// mocks/spec.js, which is shaped like a snapshot of the store example made by
// tools/mock-spec.mjs (see docs/plans/workbench-v5.md, section 10). The sample that breaks its
// schema (customerMismatch: a 3-letter country, a missing email and an undocumented
// legacyCode) is there too.
//
// Loads after spec.js and before schema.js.
(function () {
  const q = new URLSearchParams(location.search);
  if (!q.get('v5')) {
    // The v3 and v4 screens build the older .sr schema tree, which views.css no longer styles
    // (it ships the v5 attribute list, byte-identical to ui/). v4-tree.css restores those rules
    // for the mocks only, and loads parser-inserted like v5.css so the panes are measured with it.
    if (!document.querySelector('link[href="v4-tree.css"]')) document.write('<link rel="stylesheet" href="v4-tree.css">');
    return;
  }
  document.documentElement.dataset.v5 = '';
  // v5.css loads only with ?v5=1, so workbench.html keeps loading just the two shared
  // stylesheets (tests/ui/mock-styles.test.mjs) and the v3 and v4 screens are untouched.
  // document.write keeps it parser-inserted, so the scripts after this one wait for it and
  // every pane and popover is measured with the v5 styles applied.
  if (!document.querySelector('link[href="v5.css"]')) document.write('<link rel="stylesheet" href="v5.css">');
})();
