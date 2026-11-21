# Workbench v3: root-cause findings

Investigation only. No code was changed. Reproduced in Chromium (Playwright) against the running example at `http://127.0.0.1:5189/sendproof/`.
Bugs that need a signed-in user were also reproduced on a second instance of the same DLL (`:5291`, throw-away DB and `DemoKeyDirectory`, since stopped).
Line numbers refer to the current working tree.

| # | Bug | Root cause (one line) |
|---|-----|-----------------------|
| 1 | "Sign in failed (500)" | The host's ASP.NET Data Protection key ring contains a root-owned, unreadable key file, so issuing the auth cookie throws. |
| 2 | Wand does nothing | The wand on a field is a decorative, `aria-hidden` status icon. No code makes it clickable or regenerates a field. |
| 3 | Copy buttons "do nothing" | Copy works when the browser grants clipboard access, but the only success/failure feedback is in `sr-only` live regions. If clipboard access is denied the failure is silent. |
| 4 | Result tabs dead before a run | `renderTabs` marks every tab `aria-disabled` when there is no result, and the click handler ignores disabled tabs. |
| 5 | Tabs vanish after an error | `.response .tab.is-unavailable { visibility: hidden }` hides any tab whose count is 0. A 401 has no captures. |
| 6 | Tab bars not uniform | Request tabs reserve an invisible issue-count badge on some tabs only. Request and result bars use different padding, margin and badge sizes. |

---

## 1. Sign-in fails with "Sign in failed (500)"

**Symptom.** Both the password form and the "Seeded accounts" persona rows show `Sign in failed (500)` (`#auth-error`).

**Reproduce.**
- Browser: open `/sendproof/`, click the persona chip, then submit `ada.admin@acme.dev` / `Demo123!` (seed password is `DemoData.cs:7`), or click a persona. Both give 500.
- curl: `curl -i -X POST http://127.0.0.1:5189/auth/login -H 'content-type: application/json' -d '{"email":"ada.admin@acme.dev","password":"Demo123!"}'` returns 500 with the exception text in the body (Development exception page).
- Control: wrong credentials return 401 from the same host (the password check is fine).
- Control: the same DLL started with `DemoKeyDirectory=/tmp/x/keys` returns 200 plus a `Set-Cookie` for the same request. It sets `DemoKeyDirectory`, so the only difference is the key store.

**Root cause.** The server exception, in `artifacts/treasury-5189.log` (e.g. around line 3130):
```
System.Security.Cryptography.CryptographicException: An error occurred while trying to encrypt the provided data.
 ---> System.UnauthorizedAccessException: Access to the path '/Users/michaelprince/.aspnet/DataProtection-Keys/key-18031b98-….xml' is denied.
   at KeyRingBasedDataProtector.Protect → CookieAuthenticationHandler.HandleSignInAsync
   at TreasuryApi.AuthenticationEndpoints… in AuthenticationEndpoints.cs
```
- `~/.aspnet/DataProtection-Keys/key-18031b98-c166-4906-8402-8ed8cb9ea120.xml` is owned by `root:wheel`, mode `0600` (created Jun 2023). The app runs as `michaelprince` and cannot read it.
- `FileSystemXmlRepository.GetAllElements` throws on the unreadable file, so the key ring cannot load. The log also shows "Key ring failed to load during application startup".
- Cookie issuance therefore fails in `await SignInAsync(...)` at `examples/TreasuryApi/AuthenticationEndpoints.cs:21` (password login) and `:44` (persona switch). Both reach `context.SignInAsync` at `:58`.
- The example only isolates the key ring when `DemoKeyDirectory` is set (`examples/TreasuryApi/TreasuryApplication.cs:33-34`). `tools/browser-host.mjs` sets it, which is why the browser test suite passes. A plain `dotnet run` or DLL launch uses the shared user-profile ring, so it breaks on a machine with a bad key file.
- UI side: `ui/signin.js:162` shows only the HTTP status (`Sign in failed (${response.status})`) and discards the response body. A 401 shows "Sign in failed (401)" with no hint.

**Suggested fix.** Environment: delete or `chown` the root-owned key file (`sudo rm ~/.aspnet/DataProtection-Keys/key-18031b98-….xml`). Example hardening: default the key directory to a folder next to `DemoDatabasePath` when `DemoKeyDirectory` is unset, so the demo never depends on `~/.aspnet`. In `signin.js`, map 401 to "Wrong email or password" and show a short server message for 5xx.

---

## 2. The wand on a field does nothing

**Symptom.** After Autofill, each filled input shows a wand icon at its right edge. Clicking it does nothing.

**Reproduce.** Open "Sign in with a password", Autofill, then "Fill required fields". Both inputs get the wand. Click the wand: the value (`person@example.com`) stays the same and no menu opens. Measured: the wand's container is a `SPAN` with no `role`, no `tabindex`, no handler, and `cursor: auto`.

**Root cause.**
- The wand is a status marker, not a control. `ui/fields/render.js:232-246` appends `svg('wand')` to `.slot` and sets `slot.title = 'Autofilled'`. Its only listener (`:237-243`) clears the marker on input.
- `.slot` is created `aria-hidden="true"` in `ui/fields/controls.js:63-64` and is styled only as a status cell (`styles.css:361-364`).
- `ui/schema.js:310` also repaints the slot as `alert` or `wand` depending on validity, with no click path.
- No per-field regenerate exists anywhere. The only regeneration is form-wide: Autofill menu "New IDs and keys" (`ui/autofill.js:60`, `fillDraft` regenerate branch `:33-35`), which touches UUIDs only.
- "Random" is not implemented. `sampleValue` (`ui/schema.js:81-135`) returns fixed strings (`person@example.com`, `Example123!`, `value`), today's date, or a fresh UUID. Only UUIDs vary.
- The toolbar Autofill button itself works: the menu opens and fills (`request-editor.js:203`, `autofill.js:65`).

**Suggested fix.** Render the slot's wand as a real `<button>` (focusable, labelled "Regenerate value", visible on hover/focus) that calls `fillDraft` for that one path and re-renders it. Add a randomising generator (per-format, seeded from `crypto`) to `sampleValue` for the per-field case, or label the icon as "Autofilled" only if no action is intended.

---

## 3. Copy buttons do nothing and give no feedback

**Symptom.** Copy URL, Copy as cURL, Copy body, Copy line, Copy SQL, Copy as JSON, Copy all headers and the Code tab "Copy" give no visible response.

**Reproduce.**
1. Context with clipboard permission (`grantPermissions(['clipboard-read','clipboard-write'])`). Copy URL puts `http://127.0.0.1:5291/auth/login` on the clipboard, Copy SQL puts the SQL on the clipboard, and Copy body puts the JSON on the clipboard. So the copy itself works. In every case the screen shows nothing: no toast, no icon change, no label change. Screenshot of the Logs tab after "Copy SQL with values" confirms it.
2. Context without permission (Playwright default, also an embedded webview or iframe without `clipboard-write`): `navigator.clipboard.writeText` rejects with `NotAllowedError: Write permission denied`. Most copy buttons then do nothing visible. Copy URL and Copy code show a misleading failure (below).

**Root cause.** Feedback exists but is never visible:
- Copy URL, `ui/app.js:450-459`: no feedback on success. On failure it calls `showError(error)`, which replaces the whole result pane with "Unable to complete request" (`ui/results.js:164-168`). That is the wrong place for a clipboard error.
- Copy code, `ui/app.js:460-466`: same pattern. It also copies `#snippet`'s text, which is a validation message (for example `email: This field is required.`) while the form is invalid (`updateSnippet`, `app.js:~217-221`).
- Copy as cURL (`app.js:434-441`) and Copy response (`app.js:251-259`) write only to `[data-request-announcement]`, which is `sr-only` (`ui/view.js:~76`).
- Response viewer copy (`ui/response-viewer.js:351-359`) writes to `<span class="sr-only" data-response-feedback>` (`:265`).
- Capture panes (Logs, Headers, Effects) copy via `ui/result-capture.js:18-27` into `<div class="sr-only" data-capture-feedback>` (`ui/result-logs.js:144`, `ui/result-headers.js:94`).
- `.sr-only` is a 1×1 clipped box (`styles.css:119`). Sighted users see nothing, and failures are equally silent.
- `copyFailedRequest` (`ui/results.js:170-174`) has no feedback at all.

**Suggested fix.** One shared `copyToClipboard(text, anchorButton)` helper. It tries `navigator.clipboard.writeText`, then falls back to a hidden `<textarea>` with `document.execCommand('copy')` if denied. On success it swaps the button icon to a check for ~1.5s and shows a small toast; on failure it shows "Couldn't copy" without touching the result pane. Keep the `sr-only` announcement as well. Route every handler listed above through it.

---

## 4. Before a request has run, result tabs do nothing

**Symptom.** Clicking Database, Side effects, Logs or Headers before any run leaves the pane on Response.

**Reproduce.** Open any operation without running it and click a result tab. Selected tab stays Response. All five tabs report `aria-disabled="true"`, including Response itself, yet they look enabled (same colour, hover and cursor).

**Root cause.**
- `ui/results.js:327`: `const disabled = !result || !shown;`. With no result, every tab gets `aria-disabled="true"` (`:329`).
- `ui/app.js:398-401`: the click handler ignores a tab whose `aria-disabled` is `"true"`, so the click is silently dropped.
- There is no `[aria-disabled]` style (`styles.css` has only `.btn:disabled`, `:139`), so disabled tabs look clickable. `ui/commands.js` also drops them from the palette when `!state.result`.
- `renderTabs` forces `state.resultTab = "Response"` whenever the current tab is unavailable (`results.js:323`).

**Suggested fix.** Keep the tabs interactive when there is no result and render an empty state per tab (for example "Run this request to see database changes"). Alternatively style disabled tabs with reduced opacity, `cursor: not-allowed` and a tooltip.

---

## 5. After an error response, Database, Side effects and Logs disappear

**Symptom.** After a 401 the result bar shows only Response and Headers. The other tabs vanish.

**Reproduce.** Sign in form with valid-looking values, Send and Confirm send against a wrong password (401). Tab states:
```
Response       visible
Database       class="tab is-unavailable"  visibility:hidden  aria-disabled=true
Side effects   class="tab is-unavailable"  visibility:hidden  aria-disabled=true
Logs           class="tab is-unavailable"  visibility:hidden  aria-disabled=true
Headers 3      visible
```

**Root cause.**
- `ui/results.js:318-322` defines `available(tab)`: a tab is available only if its count is non-zero (or a truncation flag is set). A 401 captures no rows, effects or logs, so three tabs are unavailable.
- `ui/results.js:329` adds the class `is-unavailable` when a result exists and the tab is unavailable.
- `ui/styles.css:1048`: `.response .tab.is-unavailable { visibility: hidden; }` hides the button. It keeps its box, so the bar shows a gap where the tabs were.
- The same rule hides these tabs after any successful response with no captures. It is not specific to errors.
- Network failures take a different path: `results.js:340` calls `renderTabs(failure ? null : result)`, so all tabs stay visible but are `aria-disabled` (no `is-unavailable`). The two error cases look different.

**Suggested fix.** Remove the `visibility: hidden` rule and the `is-unavailable` class. Always show the five tabs, show a muted count of 0 (or none), and give empty tabs an explanatory empty state. If hiding is wanted, do it consistently with `display: none`.

---

## 6. Request tabs are not uniform in width and spacing

**Symptom.** Body is wider than Auth or Code and leaves blank space after its label. Gaps between tabs differ.

**Reproduce.** Open "Create payment" at 1440px. Measured widths: Body 73.8px, Headers 93.0px, Auth 46.4px, Code 49.5px. Params (on "Get payment") is 88.2px. Widths and positions are identical at 390px wide. Body keeps 73.8px even when it shows `5` issues.

**Root cause.**
- Markup, `ui/request-editor.js:195-197`. Each tab is `label + optional count (.n[data-tab-count]) + optional issue badge (.n.err[data-tab-issues][hidden])`:
  - Body: issue badge only (no count).
  - Params, Headers: count and issue badge.
  - Auth, Code: neither.
- Body's invisible reservation, `ui/styles.css:1037-1040`: `.request-tabs .tab:not(:has([data-tab-count])) [data-tab-issues][hidden] { display: inline-grid !important; visibility: hidden; }`. Only tabs without a count get this, so Body keeps a blank badge-sized box (min-width 1.15rem, `styles.css:311`, plus the 0.4rem flex gap).
- Underline workaround, `styles.css:1042-1044`: trims `::after` on the selected tab by the reserved width, so the underline stops short of the blank box.
- Params and Headers: their issue badge is `display:none` while hidden (`hidden` attribute). When issues appear `ui/issues.js:110-118` hides the count and shows the issue badge, a different width.
- Auth and Code have nothing, so they are narrowest.

**Tab bars in the app.**

| Bar | Markup | CSS | How it differs |
|-----|--------|-----|----------------|
| Request tabs | `ui/view.js:59`: `.tabs > .request-tabs[role=tablist] + .request-tools`. Buttons built at `request-editor.js:195-197`. | `.tabs` `styles.css:302`; `.tab` `303-309`; `.n` `311-312`; `.request-tabs` `1008-1010`; reservation `1037-1044`. | Padding `0 1.15rem`, `margin-top: .85rem`. Badges described above. `.right`/`.request-tools` holds the Form/JSON toggle and Autofill. |
| Result tabs | `ui/view.js:72`: `.tabs[role=tablist]` directly in `.response`. Buttons at `results.js:329`. | Same base `.tab`. `.response .tabs` padding `0 .75rem`, `margin-top: 0` (`styles.css:543`); `overflow-x: auto` (`1046`); `.n` min-width `1.35rem` (`1049`); `is-unavailable` (`1048`). | Different side padding, margin and badge size from request tabs. No issue badge. `aria-disabled` and `is-unavailable` states. `id` built with `replaceAll`. |
| Loading skeleton | `ui/index.html:35,46-47` (`.tabs > .sk-line`) | `styles.css:588` | One 60%-wide line for each bar; does not match the real bars. |
| Segmented: mobile switch | `view.js:42`, `aria-pressed` buttons | `styles.css:315-319`, `821-822` | Pill group, not tabs. |
| Segmented: Form/JSON | `request-editor.js:199`, inside `.request-tools` | same | Pill group beside the tabs. |
| Segmented: Table/Bulk edit | `header-editor.js:261` | same | Pill group. |
| Segmented: Pretty/Raw/Table | `response-viewer.js:253` | same | Pill group. |
| Segmented: log level | `result-logs.js:127` | `styles.css:704` | Pill group with counts. |
| Segmented: enum fields | `fields/controls.js:41` (`segmented lg`) | `styles.css:318-319` | Larger pill group. |

All segmented groups use `role="group"` and `aria-pressed`. Only the request and result bars are `role="tablist"` with `aria-selected`.

**Suggested fix.** Build both tab bars from one `tabButton(label, {count, issues})` helper and one set of CSS variables (padding, gap, badge size). Do not reserve space for the issue badge. Show issues as an absolutely-positioned dot/count that does not change width, or give every tab the same fixed-width badge slot. Remove the `:has()` reservation and underline workaround (`styles.css:1037-1044`).

---

## Other issues found while reproducing

1. Persona switching returns 500 too (`/auth/personas/{email}`, same cause as 1). The persona list itself loads (`GET /auth/personas` is fine), so the UI looks healthy until a row is clicked.
2. Code tab snippet and "Copy" show validation messages (`email: This field is required.`) while the form is invalid, and Copy puts that text on the clipboard (`app.js:~217-221`, `:460-466`).
3. Copy URL and Copy code failures replace the whole result pane with "Unable to complete request" via `showError` (`app.js:456-458`, `:463-465`).
4. `copyFailedRequest` (`results.js:170-174`) and the matching handler `app.js:427-433` hand any clipboard rejection to `showError`, which replaces the result pane.
5. Console messages seen: only `Failed to load resource` for the expected 401 and the 500s. No page errors, no failed (network-level) requests, no other broken buttons found in the paths exercised (nav, autofill menu, Preview, Send, confirm, Database/Effects/Logs/Headers tabs on a successful preview).
6. Stale log: `artifacts/treasury-5189.log` shows `Cookies was not authenticated. Failure message: Unprotect ticket failed` on every request after the key-ring failure, so `/auth/me` also never recognises a session on `:5189`.

## Open questions

- Which browser or webview the owner uses (affects whether clipboard writes are denied, which makes bug 3 a total silent failure rather than only invisible success).
- Whether bug 2 means the toolbar Autofill button or the per-field wand icon. The toolbar button works; the per-field icon has no behaviour. This note assumes the owner wants the per-field icon to regenerate that one value.
- Whether `~/.aspnet/DataProtection-Keys/key-18031b98-….xml` may be deleted (root-owned, needs `sudo`).
