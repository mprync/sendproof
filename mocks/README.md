# Sendproof workbench design reference

These are the approved v3 mocks, the source of truth for the workbench UI in `ui/`. v3 evolved the v2 design and kept its look: Geist, OKLCH neutrals tinted to hue 268, the same colours, radii and components. It fixes the owner's feedback on the live UI and the issues in [`docs/plans/workbench-v3-review.md`](../docs/plans/workbench-v3-review.md).

v5 (below, [v5](#v5-reference-reading-form-controls-response-viewer-and-languages)) is the owner's review of the live v4 app: a Stripe-style reading experience for models and Docs, new selects and radio groups, one field anatomy, a deprecation notice that names the replacement, a one-line response toolbar with four real views, and 34 UI languages. Every v5 screen has `v5=1` in its query; without it the v3 and v4 screens render exactly as before. The plan is [`docs/plans/workbench-v5.md`](../docs/plans/workbench-v5.md).

v6 (below, [v6](#v6-data-stores-mongodb-preview-guarded-stores-and-db-command-logs)) designs the UI that NoSQL data stores need, under the new product name Sendproof: nested MongoDB document diffs, one Preview across SQL and MongoDB grouped by store, database-command logs, and "Preview unavailable" before and during a run. Every v6 screen has `v5=1&v6=1` in its query (`stores.html` boards take `v6=1`); without it nothing v6 loads.

v4 (below, [Navigation and reference](#navigation-and-reference-v4)) adds the owner's review of the live v3 app: a stable shell, one reference space for Docs and Models, a new model visualiser, a prominent signed-out notice, expanded JSON and aligned bottom bars. The mocks render the Acme Store API, a made-up online store (products and variants, inventory, customers, carts, orders, payments and refunds, shipments, reviews, coupons, users and roles): `mocks/spec.js` holds its OpenAPI document and seeded responses.

Open `workbench.html`, `board.html`, `flow.html` or `stores.html` in a browser. Query parameters select each state. To regenerate the PNGs in `screens/`, run `node tools/shoot-mocks.mjs` (desktop 1440×900, mobile 390×844, v6 phones 320×844, all at 2×). Add a name filter to render a subset, for example `node tools/shoot-mocks.mjs docs m0`.

## Files

| File | What it holds |
| --- | --- |
| `spec.js` | The Acme Store API's OpenAPI document (`TB_SPEC`) and sample responses (`TB_SAMPLES`: `ordersPage`, `ordersLarge`, `order`, `customersPage`, `customer`, `customerMismatch`, `productsPage`). Hand-written and deterministic, in the shape `node tools/mock-spec.mjs` writes from a running store example, so a snapshot can replace it while the operation IDs and sample names stay the same |
| `sidebar.js` | The sidebar (`TB.buildSidebar`), the operation resolver (`TB.currentOp`) and the main column's head row with breadcrumbs (`TB.ctxBar`) |
| `flow.html` | The navigation sequence and the alignment board, built from the rendered PNGs (`?set=after|align`) |
| `styles.css` | Tokens (type, size and density), base, primitives, the tab component, the stable shell (head rows, bottom bars, signed-out notice), form, action bar, popovers, result pane, states, mobile |
| `views.css` | Request extras, result tabs, JSON viewer, property tree, Docs and Models panes, sign-in, overlays, boards |
| `i18n.js` | Externalised strings (en, de, ar), plural rules, `Intl` number, date and unit formatting, shortcut glyphs per platform |
| `shell.js` | Icons and the shared builders: `kbd`, `tab`, `copyBtn`, `copyTextBtn`, `state`. Also the top bar |
| `schema.js` | Reads `spec.js`: `$ref`, `allOf`, `oneOf` and discriminators, usage, examples. Renders the property tree (Models, Docs, response Schema view) and the JSON viewer |
| `request.js` | Request pane (`TB.buildRequest`): fields, wand, toggletips, headers, auth, code, action bar |
| `results.js` | Result pane (`TB.buildResult`): five tabs, each with content, a zero state or an explanation |
| `docs.js`, `models.js` | The Docs view of an operation, the API overview and the model page, all built from `spec.js` |
| `states.js` | Whole-page states: sign-in (with errors), loading, spec error |
| `overlays.js` | Display settings, toggletip, generate menu, issues list, Send tooltip, history, Autofill, ID lookup, shortcut sheet, command palette |
| `handles.js` | Pane dividers (focusable separators) and the size tip |
| `board.js` | State boards built from the same builders, so they can't drift from the screens |
| `v5-spec.js` | v5: flags the page and loads `v5.css`. The spec changes v5 relies on (`x-replaced-by`, `x-sunset`, `x-enum-descriptions`) and the response that breaks its schema (`customerMismatch`) live in `spec.js`. Loads before `schema.js` |
| `v5.js` | v5: the attribute list (replaces `S.tree` and `S.rows`), the field anatomy, select, radio group, listbox, deprecation notice and operationId links |
| `v5-panes.js` | v5: the Try it request pane and result pane, rebuilt from the spec; the Docs deprecation notice, the enum page and the Docs response-example fix |
| `v5-overlays.js` | v5: select listboxes with search and type-ahead, the ID lookup popover and its states, the language picker, the deprecated-operation tooltip and the schema-match toggletip |
| `v5.css` | v5: every v5 style, scoped to `:root[data-v5]`. `v5-spec.js` loads it only with `?v5=1`, so `workbench.html` still links just `styles.css` and `views.css`, which stay byte-identical to `ui/` |
| `controls.html`, `v5-board.js` | v5 state boards: every control state, the field anatomy and the lookup popover states (`?v5=1&set=controls|anatomy|lookup`) |

## Parameters

`view=try|docs|model|overview|signin` · `op=create|get|list|update|login` · `tab=body|params|headers|auth|code` · `state=blank|filled|validation|running|generated` · `run=none|running|preview|send|401|neterror` · `rtab=response|database|effects|logs|headers` · `rview=schema` · `overlay=display|toggletip|wand|issues|send-tip|history|autofill|lookup|shortcuts|palette` with `focus=<field>` · `copied=url|code|body|sql|headers|failed|bodyfailed` · `auth=out` · `side=models` · `model=<schema name>` with `from=<operationId>` (opened from that operation), `via=<model>` (an intermediate model on the trail), `variant=<name>`, `expand=<paths>`, `expandAll=1`, `aside=example|schema`, `strip=descriptions` (shows an undocumented schema) · `opid=<operationId>` (Docs of any operation) · `open=<codes>` (responses) · `collapsed=<tags>` (remembered sidebar groups) · `drawer=1` (mobile sidebar) · `body=large` and `json=collapsed` (JSON viewer) · `filter=nomatch|empty` · `hstate=empty|invalid` · `logs=empty` · `effects=zero` · `boot=loading|error` · `signin=error500|wrong` and `details=1` · `theme=dark` · `density=compact|comfortable` · `traced=off` · `digits=arab` · `resizing=1` · `text=130` · `lang=en|de|ar` · `platform=mac|win` · `mview=request|result` (mobile) · `scrollto=<field>` and `scroll=<section id>` (mock-only scrolling). Boards: `board.html?set=before-run|zero|copy`. Flows: `flow.html?set=before|after|align`.

## Screens

Feedback numbers refer to the owner's list (F1–F11). Review numbers (R…) refer to the review table.

| PNG | Query | Problem it solves |
| --- | --- | --- |
| 01-request-default | `state=filled&run=preview&rtab=database` | F1 new scale: 14 px text, 36 px controls, 40 px tabs. F2 one keycap per button at a fixed width. F7 one tab component with small count badges |
| 02-request-default-dark | same `&theme=dark` | Dark theme at the new scale |
| 03-density-compact | `density=compact&…` | F1 Compact density: 13 px text, 32 px controls, same layout |
| 04-density-comfortable | `density=comfortable&…&rtab=response` | F1 Comfortable density: 15 px text, 40 px controls |
| 05-display-settings | `overlay=display&state=filled` | F1 density, theme, text size (follows zoom and OS text size) and language in one place, ⌘, |
| 06-send-tooltip | `overlay=send-tip&state=filled` | F2 the long shortcut form and what Send does, in a tooltip |
| 07-before-run-response | `state=blank&rtab=response` | F4 Response tab before a run: steps with shortcuts and the documented responses. R: blank fields always have a hint |
| 08-before-run-side-effects | `state=blank&rtab=effects` | F4 every tab explains what will appear and how to get it |
| 09-signed-out | `auth=out&state=blank&rtab=response` | F6 signed out: Sign in button in the top bar, locks on operations that need sign-in, a notice on the operation, lookups say why they're empty |
| 10-signed-out-auth-tab | `auth=out&tab=auth&…&rtab=database` | F6 the Auth tab lists the security requirements and whether you meet them |
| 11-result-401 | `auth=out&op=list&run=401&rtab=response` | F3, F6 a 401 explains what happened and offers Sign in and retry. All five tabs stay, with counts |
| 12-result-401-database-dark | `…&rtab=database&theme=dark` | F3 a zero state, not a hidden tab |
| 13-send-not-captured | `state=filled&run=send&traced=off&rtab=database` | F3 "Send doesn't capture database changes. Use Preview, or turn on traced Send." |
| 14-signin-error | `view=signin&signin=error500` | F6 sign-in 500: what happened, what to do, collapsed technical details, a way back |
| 15-signin-error-dark | `…&theme=dark&details=1` | F6 details expanded, with Copy details |
| 16-signin-wrong-password | `view=signin&signin=wrong` | R: a 401 from sign-in is "Wrong email or password", not "Sign in failed (401)" |
| 17-copied-url | `…&copied=url` | F5 the URL copy becomes a check with a "Copied" bubble, with no layout shift |
| 18-copied-sql | `…&rtab=logs&copied=sql` | F5 SQL copy, in a bar that never covers the SQL |
| 19-copy-failed-body | `…&copied=bodyfailed` | F5 clipboard blocked: an inline notice, the text selected, ⌘C. The pane is never replaced |
| 20-code-placeholders | `tab=code&state=blank` | R: an invalid form still gives a snippet, with typed placeholders and an inline notice |
| 21-code-copy-failed | `tab=code&state=blank&copied=failed` | F5 the same failure path in the Code tab |
| 22-validation | `state=validation&overlay=issues` | F7 issue marker is a dot that doesn't change the tab's width; the count is in the action bar. R: replaces the broken red banner |
| 23-field-toggletip | `state=filled&overlay=toggletip&focus=amount` | F8 the "i" toggletip: description, type, constraints, example and how it's sent |
| 24-docs | `view=docs` | F8 the Docs view, now in the stable shell: summary, markdown description, tags, security, parameters, request schema, responses; outline and samples on the right |
| 25-docs-responses-dark | `view=docs&scroll=responses&theme=dark` | F8 every documented response, each with its schema |
| 26-docs-deprecated | `view=docs&op=update` | F8 deprecation on the real deprecated operation (Get available stock): badge, notice with the replacement, strikethrough and a warning marker in the sidebar |
| 27-model-payment | `view=model&model=Order&side=models` | F9 the v4 model page picked from the Models tab: one row anatomy, Used by, a real example |
| 28-model-ref-oneof | `view=model&model=Fulfilment&from=ProductsController.Create&via=Product` | F9 oneOf with its discriminator mapping and variant tabs, reached from Add product › Product; Back to Product (⌥←) |
| 29-model-ref-oneof-dark | same `&theme=dark&variant=FulfilmentDigital` | F9 in dark; the example follows the picked variant |
| 30-response-schema | `…&rtab=response&rview=schema` | F9 the second place: the response body's schema, marking which properties came back |
| 31-wand-menu | `state=filled&overlay=wand&focus=amount` | F11 the per-field Generate button: valid values within the constraints, and invalid ones to test errors |
| 32-wand-generated | `state=generated` | F11 generated values say where they came from, with Undo in the assist line and in the action bar |
| 33-get-read-only | `op=list&rtab=response` | R: a GET has no Preview; the bar says why instead of showing a disabled button |
| 34-filter-no-match | `filter=nomatch&state=filled` | F10 filter with no matches |
| 35-history-empty | `overlay=history&state=filled` | F10 empty history |
| 36-headers-empty | `tab=headers&hstate=empty&rtab=headers` | F10 no custom headers; the managed ones stay listed |
| 37-logs-filtered-empty | `…&rtab=logs&logs=empty` | F10 logs filtered to nothing, naming the filters |
| 38-side-effects-zero | `…&rtab=effects&effects=zero` | F10 zero items after a run |
| 39-loading | `boot=loading` | F10 loading mirrors the final layout |
| 40-spec-error | `boot=error` | F10 the OpenAPI document failed to load |
| 41-network-error | `state=filled&run=neterror` | F10 the API is unreachable |
| 42-board-before-run | `board.html?set=before-run` | F4 all result tabs before a run, side by side |
| 43-board-zero-and-empty | `board.html?set=zero` | F10 zero, no-match and not-captured states, one anatomy |
| 44-board-copy-feedback | `board.html?set=copy` | F5 idle and copied pairs for URL, body, SQL and headers; the failure path; timing |
| 45-i18n-de-DE | `lang=de&…&rtab=database` | i18n: German expansion, de-DE numbers and dates in fields, Windows shortcuts, locale button widths |
| 46-rtl-ar | `lang=ar&…&rtab=database` | RTL: Arabic, mirrored with logical properties, Latin digits by default (`digits=arab` for Arabic-Indic), code and paths isolated LTR |
| 47-rtl-ar-dark-docs | `lang=ar&view=docs&theme=dark` | RTL Docs: English spec text keeps its own direction inside the Arabic UI |
| 48-api-overview-signed-out | `view=overview&auth=out` | R: first visit lands on an API overview that explains Preview, Send and Autofill, shows sign-in status and where to start, instead of opening "Sign in with a password" |
| 49-send-traced | `state=filled&run=send&rtab=database` | Owner decision: traced Send is on by default in Development, so Send shows the committed rows, effects and logs, with a way to turn it off |
| 50-display-settings-ar | `lang=ar&overlay=display&state=filled` | Owner decision: Arabic uses Latin digits by default; Display settings offers Arabic-Indic digits |
| 51-autofill | `state=blank&overlay=autofill` | Carried from v2: the Autofill menu (fill required, fill all, reuse, new IDs, clear) |
| 52-id-lookup | `op=get&tab=params&overlay=lookup` | Carried from v2: the ID lookup combobox, last response first, paste and random UUID |
| 53-headers-invalid-dark | `tab=headers&hstate=invalid&theme=dark` | Carried from v2: a header row with an invalid name and its fix |
| 54-in-flight-resizing | `state=running&resizing=1` | Carried from v2: a running Preview while the sidebar divider is dragged |
| 55-keyboard-shortcuts | `state=filled&overlay=shortcuts` | Carried from v2: the shortcut sheet, one keycap per chord |
| 56-command-palette | `state=filled&overlay=palette` | Carried from v2: the command palette with scoped actions |
| 57-shell-try-it | `auth=out&state=filled&run=preview&rtab=response` | v4 Try it in the stable shell: signed-out notice at the top of the sidebar, every group open, locks on rows, real JSON fully expanded, three bottom bars on one line |
| 58-shell-docs | `auth=out&view=docs` | v4 Docs in exactly the same columns as Try it: pressing D swaps content, never layout |
| 59-shell-model | `auth=out&view=model&model=Order&from=OrdersController.Create` | v4 a model opened from an operation: breadcrumbs Orders › Create order › Order and one Back control, "← Back to Create order ⌥←"; the sidebar stays on Operations with the operation marked as context |
| 60-docs-inline-expand | `auth=out&view=docs&scroll=responses&expand=customer` | v4 a $ref expanded in place inside the 201 response, with indent guides; only rows with something inside have a chevron |
| 61-model-nested-ref | `…&model=OrderLine&from=OrdersController.Create&via=Order` | v4 the trail grows one step per followed $ref; "Used by" lists operations through the models that contain it |
| 62-models-tab | `view=model&model=Order&side=models` | v4 the Models tab only when the user picks it; models grouped into resources, request bodies, list pages (collapsed at first), enums and errors |
| 63-model-json-schema-dark | `…&aside=schema&theme=dark` | v4 the raw JSON Schema beside the tree, one switch from the example |
| 64-model-expand-all | `…&expandAll=1` | v4 Expand all opens every nested object and $ref one level, cycle-safe |
| 65-model-no-description | `view=model&model=Customer&side=models&strip=descriptions` | v4 an undocumented schema says "No description in the spec" quietly, instead of an empty expander |
| 66-model-enum | `view=model&model=OrderStatus&side=models` | v4 an enum as a compact value grid, with one quiet note when the spec describes none of the values |
| 67-signed-out-docs-dark | `auth=out&view=docs&theme=dark` | v4 the signed-out notice and lock markers in dark |
| 68-json-expanded | `op=get&run=send&rtab=response` | v4 JSON opens with every object expanded, indent guides and Collapse all; a GET shows 200 and zero changes |
| 69-json-large | `op=list&run=send&rtab=response&body=large` | v4 a 96 kB list starts collapsed below the second level and says so; collapsed items show their size and number |
| 70-sidebar-groups-remembered | `state=filled&collapsed=Authentication,Customers,Inventory` | v4 groups are open by default; collapsed ones are remembered per API |
| 72-board-nav-after | `flow.html?set=after` | v4 the same journey in six steps, with the URL of each step and where Back goes |
| 73-board-alignment | `flow.html?set=align` | v4 guides measured by the capture script: identical column edges, head line and bar line in Try it, Docs and Models |
| 74-docs-oneof-inline | `view=docs&opid=ProductsController.Create&scroll=body&expand=fulfilment` | v4 a oneOf inside a request body: "Chosen by type", the variant switch and the chosen variant's rows inline |
| 75-docs-list-parameters | `view=docs&opid=OrdersController.List&theme=dark` | v4 query parameters (pagination, filters, sort) in the same row anatomy as properties |
| m01-request | `state=filled` (390 px) | Mobile request with 44 px targets |
| m02-request-130-dark | `state=filled&text=130&theme=dark` | 130% text, dark |
| m03-result-before-run | `state=blank&mview=result&rtab=database` | F3/F4 on mobile: tabs scroll with a fade, never hide. R: fixes the stretched Request/Result switch |
| m04-result-401 | `auth=out&op=list&run=401&mview=result` | F6 on mobile |
| m05-toggletip | `…&overlay=toggletip&focus=amount` | F8 on mobile |
| m06-wand-menu | `…&overlay=wand&focus=amount` | F11 on mobile |
| m07-docs | `view=docs` | F8 Docs stacked on mobile |
| m08-model-ref | `view=model&model=Order&from=OrdersController.Create&expand=customer` | F9 on mobile, a $ref expanded inline |
| m09-signin-error | `view=signin&signin=error500&details=1` | F6 on mobile |
| m10-de-130 | `lang=de&text=130&…&mview=result` | German at 130% on 390 px |
| m11-rtl-ar | `lang=ar&state=filled` | Arabic on mobile |
| m12-headers-130-dark | `tab=headers&hstate=invalid&theme=dark&text=130` | Carried from v2: headers at 130% text on 390 px, dark |
| m13-docs-signed-out | `auth=out&view=docs` | v4 Docs on a phone: main and right columns stack in one scroll, the bar with Try it stays at the bottom |
| m14-model-from-docs | `view=model&model=Order&from=OrdersController.Create` | v4 the model page on a phone: the head row shows the page and "Back to Create order" |
| m15-drawer-signed-out | `auth=out&state=filled&drawer=1` | v4 the sidebar drawer with the signed-out notice and 44 px targets |
| m16-json-expanded-dark | `op=get&run=send&rtab=response&mview=result&theme=dark` | v4 expanded JSON on a phone, dark |
| m17-model-130 | `view=model&model=Fulfilment&…&text=130` | v4 a union at 130% text on 390 px |

## Navigation and reference (v4)

The owner reviewed the live v3 app: the layout jumped between Try it, Docs and Models, a model opened from Docs had no way back, some property rows had tags and others nothing, expanders opened to nothing, "Locked operations need sign-in" was easy to miss, JSON opened collapsed, groups started closed, the three panes ended at different heights, and the demo data was too thin to judge. `72` shows the journey after the fixes.

- **One stable shell.** The workspace is always three columns: sidebar, main and right. Try it puts the request and the result in them; Docs puts the reference page and its outline plus samples; a model page puts the property tree and its usage plus an example. The divider position is shared by all three and survives resizing. `tools/shoot-mocks.mjs` measures the column edges, the head line and every pane's bottom-bar line in all three views and fails if any differ.
- **One head line, one bottom line.** Every column starts with a head row exactly as tall as a tab row (sidebar tabs, breadcrumbs, result status, "On this page", "Used by") and ends with a bar of `--bar-h` (sidebar foot, action bar, result bar, Docs and Models bars).
- **Docs and Models are one reference space.** Breadcrumbs say where you are, not which tab is selected. A model opened from an operation keeps it: Orders › Create order › Order › OrderLine. The one Back control in the head row ("← Back to Order ⌥←") and browser history unwind the trail and restore the scroll position. The sidebar tab changes only when the user picks it; meanwhile the operation stays marked as the current context.
- **Deep links.** `#op/<operationId>` (Try it), `#docs/<operationId>`, `#model/<Name>` (from the Models tab) and `#model/<Name>?from=docs/<operationId>&via=<Model>` (from an operation). Expanding a schema inline is not navigation and doesn't change the URL.
- **One property row anatomy.** Toggle slot (empty when there's nothing inside), name, type (a `$ref` is a link and expands inline), "required" or "optional" on every row, the description or a quiet "No description in the spec", then chips in one style and order (format, min, max, step, length, pattern, items, default, read-only, write-only, nullable, deprecated), enum values and the example. Indent guides mark each level. A `oneOf` row says how the variant is chosen ("Chosen by `scheme`") and switches variants in place.
- **Examples are real when they can be.** A model's example is a real record from the demo database when one fits the schema, otherwise the schema's own example, otherwise one built from enums and formats; the bar says which.
- **Signed out is obvious.** A notice at the top of the sidebar ("You're signed out. 42 of 46 operations need sign-in.") with Sign in (⇧⌘U) and seeded accounts, a lock on every locked row, the primary Sign in button in the top bar and the notice on the operation itself.
- **JSON reads without clicking.** Every object and array opens, with indent guides and Collapse all. Only bodies over 2,000 lines start collapsed below the second level, with a note saying so.
- **Model titles use the operation title font**, not the code font; the `$ref` path beside it stays monospace.
- **Sidebar groups start open.** In Models, List pages (`PagedListOf…`) start collapsed. Each heading collapses its group; the state is stored per API. Collapse all lives in the sidebar foot.

## Design rules (new in v3)

- **Scale in rem only.** Default is 14 px body, 12.5 px assist, 11.5 px badges, 36 px controls, 40 px tabs, 34 px nav rows, 21 px keycaps and 17 px icons. The owner chose this step: larger than v2, smaller than the first v3 draft. Browser zoom and the OS text size scale everything. On mobile, and wherever the pointer is coarse, targets are 44 px.
- **Density swaps tokens, never layout.** Compact, Default and Comfortable change sizes only. The setting lives in Display settings (⌘,).
- **One tab component.** The request, result, sidebar, variant and sample tabs all use `.tab`: same height, padding, type and badge. A count badge is 20 px; "–" means not known yet. An issue marker is a 7 px dot overlaid on the tab's top end, so it never changes the tab's width. The issue count lives in the action bar.
- **Tabs never hide.** All five result tabs exist in every state. Each shows content, a zero state ("No database changes"), or why nothing was captured ("Send doesn't capture database changes"). In a narrow pane the tab row scrolls, and a fade at the end says there are more.
- **One keycap per shortcut.** A chord is one chip: `⇧⌘↵` on Mac, `Ctrl ⇧↵` on Windows. Buttons have fixed, per-locale widths, so the spinner, the copied state and translations never move the bar. Tooltips, menus and the shortcut sheet use the long form, such as `Ctrl+Shift+Enter`.
- **Copy feedback overlays.** The icon becomes a check, a "Copied" bubble appears above the button for 1.5 s, a polite live region says "URL copied", then it fades back (instantly with reduced motion). Text buttons swap "Copy" and "Copied" inside one grid cell. If the clipboard is blocked, an inline notice appears where the copy was, the text is selected and the notice says to press ⌘C. A clipboard error never replaces a pane.
- **The spec is the documentation.** Every field has an "i" toggletip button (a 24 px target). It opens on hover, focus or click, and Esc or a click outside closes it. Every operation has a Docs view (D switches Try it ⇄ Docs). Every schema is a model page reachable from the sidebar's Models tab, from type links, and from the response Schema view.
- **Generated values are honest.** The wand is a real button in each field's status slot. It shows on hover and focus, ⌥G generates, and ⌥⇧G opens the menu. The value is random within the schema's constraints. The assist line says "Generated: …" with Undo (⌘Z). The menu also offers invalid values, for testing the API's errors.
- **Every field has a hint.** The reserved assist line is never visually empty in a blank form. It shows the description, the lookup source or a type-derived hint, so the field rhythm stays even.
- **Data stays invariant; chrome follows the locale.** Captured rows, JSON, SQL and headers show exactly what was stored or sent. Inputs, prose, counts, metrics and plurals use `Intl` for the UI locale. Spec text keeps its own language (`lang="en"`) and direction.
- **Safe methods don't pretend.** A GET shows one primary Send. The bar says "GET is read-only: nothing to roll back, so there's no Preview" instead of showing a disabled button.

## What the wand generates

| Schema | Valid values (random within constraints) | Invalid values offered |
| --- | --- | --- |
| `string` + `maxLength` / `minLength` | Readable words sized between the limits | One character over the limit, empty |
| `string` + `pattern` | A value matching the pattern (for example a SKU such as `APP-MCS-HGR-M`) | A value that breaks the pattern |
| `string` `format: email` | `firstname.lastname@example.test`, varied | `not-an-email` |
| `string` `format: uuid` | A fresh v4 UUID; for lookups, a real record the user can see | A random UUID that doesn't exist (tests 404) |
| `string` `format: date` / `date-time` | A business day within 30 days; now ± random offset in ISO 8601 | 31 February, wrong order |
| `number` / `integer` + `minimum` / `maximum` / `multipleOf` | Random in range, respecting decimals | Below minimum, above maximum, too many decimals, not a number |
| `boolean` | Toggled | None |
| `enum` | A random member other than the current one | A value outside the enum |
| `array` + `minItems` / `maxItems` | Random length within limits, items generated by type | One item too many |
| `object` / `$ref` | Each required property generated recursively | A required property missing |

## v5: reference reading, form controls, response viewer and languages

The owner reviewed the live v4 app. v5 takes the reading experience of Stripe's API reference and fits it to our tokens: Geist, OKLCH neutrals, the accent and both themes. Every v5 screen adds `v5=1`; v5 lives in its own files (`v5*.js`, `v5.css`, `controls.html`), so the v3 and v4 screens and `tests/ui/mock-styles.test.mjs` are untouched.

### Parameters (v5)

`v5=1` turns v5 on. `opid=CustomersController.List` (default) `| CustomersController.Get | InventoryController.LegacyStock | OrdersController.Create` picks the Try it operation · `state=filled|blank|validation|generated` · `focus=<field>` and `hover=<field>` show focus and hover · `pop=<field>` opens a select's listbox (`status`, `segment`, `currency`, `sort`) with `search=<query>`, `typed=<buffer>` (type-ahead) and `active=<value>` · `pop=id` opens the ID lookup, `lstate=loading|empty|error` (signed out comes from `auth=out`) · `pop=lang` with `overlay=display` opens the language picker, `lsearch=<query>` and `lactive=<language>` · `pop=dep-tip` shows the deprecated operation's sidebar tooltip · `run=send` with `rview=pretty|raw|table|schema`, `match=fail` (the body breaks its schema), `pop=match` (the schema-match toggletip), `wrap=1` (Raw wraps) · `narrow=1` (a narrow result pane) · `mscroll=<attribute path>` (scrolls a model page to that attribute) · `collapse=<paths>` (child lists the user closed; everything else starts open) · `tscroll=1` (the Table view scrolled sideways and down) · `lang=ja|he` (v5 i18n screens). Boards: `controls.html?v5=1&set=controls|anatomy|lookup`.

### Screens (v5)

Feedback numbers are the owner's v5 list: V1 enum control, V2 selects, V3 languages, V4 model viewer, V5 deprecation, V6 field footer, V7 response toolbar, V8 response views.

| PNG | Query (`v5=1&` plus) | Problem it solves |
| --- | --- | --- |
| 76-v5-fields | `opid=CustomersController.List` | V1 `status` is a radio group with a filled dot, an accent border and a tint: the choice is unmistakable. V2 `type` and `currency` are field-styled selects with a joined trigger. V6 every field: label row, control, description, then one status line ("Sends `status=Open`", "Not sent while unset", "1 to 100 · Default 25") |
| 77-v5-fields-dark | same `&theme=dark` | V1, V2, V6 in dark, where the old segmented selection was hardest to see |
| 78-v5-select-open | `…&pop=segment&active=Wholesale` | V2 the listbox: "Any" first (clears an optional field), each value with its description, a check on the chosen value, the active row tinted, keys in the footer |
| 79-v5-select-search | `…&pop=currency&search=kr&theme=dark` | V2 more than 8 values get a search box; it matches values and descriptions ("kr" finds krona and krone) |
| 80-v5-select-typeahead | `…&pop=sort&typed=-s` | V2 type-ahead: typing "-s" jumps to `-spend`; the footer echoes what was typed. The popover flips above when there's no room below |
| 81-v5-lookup-open | `opid=CustomersController.Get&pop=id` | V2 the ID lookup in the same system, at the trigger's width: search by name, email or ID, the last response first, every customer with their email and currency, Paste an ID and a random UUID. V6 the source moves into the popover footer, on one line: `GET /api/v2/customers` · as Ada Admin · 25, then Refresh; the query string truncates first and the full request is its title |
| 82-v5-board-controls | `controls.html?v5=1&set=controls` | V1, V2 radio group, select, lookup and text in every state: rest, hover, focus, selected with Clear, generated, error, disabled; then open, type-ahead, search and lookup open; then when an enum is a radio group or a select, and long values wrapping |
| 83-v5-board-controls-dark | same `&theme=dark` | The same states in dark |
| 84-v5-board-anatomy | `controls.html?v5=1&set=anatomy` | V6 the four-part anatomy (label row, control, description, status line), then every field type on one subgrid, so paired fields line up whatever their descriptions' length |
| 85-v5-board-lookup-states | `controls.html?v5=1&set=lookup` | V2 the lookup popover loaded, loading (skeleton rows in the same shape), empty, error (Retry) and signed out; paste works in every state |
| 86-v5-validation | `…&state=validation&scrollto=q` | V6 errors take over the status line, so nothing moves: `q` too long (with its count), `page` and `pageSize` out of range; the issue count stays in the action bar |
| 87-v5-create-payment | `opid=OrdersController.Create&focus=deliverBy&scrollto=unitPrice` | V6 the anatomy on a body: lookups, unit price with a joined currency segment, a date with its weekday, `shippingMethod` as a radio group with Clear, a counted reference |
| 88-v5-deprecated-try-it | `opid=InventoryController.LegacyStock` | V5 the notice in Try it: "Stops working on 30 June 2027 · in 7 months", the replacements as links with their method and why, "Open Get stock level" carrying `id` as `variantId` |
| 89-v5-deprecated-docs | `view=docs&opid=InventoryController.LegacyStock&theme=dark` | V5 the same notice in Docs ("Try Get stock level"); operationIds in the description become links ("GET Get stock level") |
| 90-v5-deprecated-sidebar-tip | `pop=dep-tip` | V5 the sidebar tooltip: Deprecated, the sunset date and what to use |
| 91-v5-model-account | `view=model&model=Customer&side=models` | V4 flat rows on hairlines: bold mono name, muted type, Required or Optional on the same line, the description flush beneath, constraints as quiet text ("Length 2   Pattern `^[A-Z]{2}$`") |
| 92-v5-model-nested-dark | `view=model&model=StockLevel&side=models&theme=dark` | V4 the owner's example: child lists start open; "Hide child attributes" heads the bordered, inset list; "Possible enum values" with descriptions |
| 93-v5-model-oneof-deep | `view=model&model=Product&side=models&collapse=shipsFrom&mscroll=shipsFrom` | V4 a collapsed child list (`shipsFrom`, remembered) as the "Show child attributes" pill, then a oneOf open: "Chosen by `type`", a tab per variant, the variant's rows; its one-value discriminator reads as a constant |
| 94-v5-model-array-deep | `view=model&model=Order&side=models&mscroll=lines` | V4 an array of objects with a child list inside a child list |
| 95-v5-model-union | `view=model&model=Coupon&side=models` | V4 a top-level union: discriminator table, variant tabs, the attribute list |
| 96-v5-model-enum | `view=model&model=OrderStatus&side=models` | V4 an enum's page as "Possible enum values", each value with its description, instead of a chip grid |
| 97-v5-docs-params | `view=docs&opid=CustomersController.List` | V4 query parameters in the same list; enums list their values. Extra fix: the response example shows customers, not orders |
| 98-v5-docs-body | `view=docs&opid=OrdersController.Create&scroll=body` | V4 the request body in the same list |
| 99-v5-docs-responses-dark | `view=docs&opid=CustomersController.Get&scroll=responses&theme=dark` | V4 a response's schema in the same list, inside its response row |
| 100-v5-response-match | `opid=CustomersController.Get&run=send&pop=match` | V7 the match is a small "✓ Matches schema" in the status line after status, time and size; its toggletip says what was checked. The toolbar is one line: views, then icon actions |
| 101-v5-response-mismatch | `…&match=fail&pop=match` | V7 "⚠ 3 schema issues": the toggletip lists each path and why; Pretty marks the lines with a quiet reason at the end |
| 102-v5-response-schema | `opid=CustomersController.Get&run=send&rview=schema` | V8 Schema view: the attribute list in compact rows, a presence dot at the line end (no indent) and a one-line legend |
| 103-v5-response-schema-mismatch-dark | `…&rview=schema&match=fail&theme=dark` | V7, V8 how to see why: the failing rows are tinted with their reason; an undocumented property is listed as "Not in the schema" |
| 104-v5-response-table | `opid=CustomersController.List&run=send&rview=table` | V8 a real table: sticky header, sticky row numbers and name, aligned numbers, horizontal scroll with an edge fade while columns remain, and "15 columns, scroll →" in the footer |
| 111-v5-response-table-scrolled | `…&rview=table&tscroll=1&theme=dark` | V8 the same table scrolled right and down: the header, the row numbers and the name column stay, and the name column casts a shadow |
| 112-v5-select-open-rtl | `lang=he&opid=CustomersController.List&pop=segment&active=Staff` | V2 in RTL the listbox anchors to the trigger's start (right) edge at the trigger's width |
| 105-v5-response-raw | `opid=CustomersController.Get&run=send&rview=raw` | V8 Raw: the bytes as received, monospace, one line that scrolls sideways, Wrap as an option |
| 106-v5-response-narrow | `…&match=fail&narrow=1` | V7 a narrow result pane: still one toolbar line (labels give way to icons) and the status line holds |
| 107-v5-language-picker | `overlay=display&pop=lang` | V3 a searchable picker with 34 languages in six groups: autonym, English name and region, the check, and that language's own number and date format |
| 108-v5-language-rtl-preview | `…&lsearch=he&lactive=he-IL` | V3 search matches English names too ("he" finds Hebrew and the Netherlands); an RTL language previews a real field, mirrored, before you switch |
| 109-v5-i18n-ja | `lang=ja&opid=CustomersController.List&run=send&rview=table` | V3 Japanese: CJK text in the chrome (Noto Sans JP after Geist), spec text stays English, no clipping in tabs, buttons or the table |
| 110-v5-i18n-he-docs | `lang=he&view=docs&opid=CustomersController.List` | V3 Hebrew Docs: the mirrored attribute list; English spec text keeps its direction and lines up with the right edge |
| m18-v5-fields | `opid=CustomersController.List` (390 px) | V1, V2, V6 on a phone: radio options grow to fill the row, 44 px targets, Clear has a 44 px hit area |
| m19-v5-select-130 | `…&pop=segment&active=Staff&text=130` | V2 on a phone the listbox is a bottom sheet (grab handle, the field name and description as its title, Close, safe-area padding) so it never covers its trigger; 130% text |
| m20-v5-rtl-he | `lang=he&…&pop=currency` | V2, V3 the sheet in RTL, with search for a long list: the check moves to the other side, values stay LTR |
| m21-v5-model-nested | `view=model&model=StockLevel&side=models` | V4 the inset child list on a phone, open by default |
| m22-v5-response-dark | `opid=CustomersController.Get&run=send&match=fail&mview=result&theme=dark` | V7, V8 the status line wraps cleanly; the toolbar stays one line |
| m23-v5-deprecated | `opid=InventoryController.LegacyStock` | V5 the notice on a phone, full width |
| m24-v5-lookup-130-dark | `opid=CustomersController.Get&pop=id&text=130&theme=dark` | V2 the ID lookup as a sheet at 130% text, dark; the source footer stays one line |
| m25-v5-language-sheet | `pop=lang&lsearch=he&lactive=he-IL` | V3 the language picker as a sheet, with the RTL preview |

### Design rules (new in v5)

- **Reference reading follows Stripe.** Attribute lists are flat rows on hairlines with no boxed cards. A row is: name in bold mono, the type in muted text (a model name is a link; `nullable string`, `array of OrderLine`), then "Required" or "Optional" on the same line. The description sits beneath, flush with the name. Constraints are quiet inline text ("Max length 42   Pattern `…`"). Enums list "Possible enum values", each with its description; without descriptions they're a compact inline list, and past 6 values the rest hide behind "Show N more values". Leaf rows have no toggle column and no indent.
- **Child attributes start open**, like JSON and the sidebar groups: three levels deep, cycle-safe. "Hide child attributes" heads each bordered, inset list; closed, it's the "Show child attributes" pill. What the user closes is remembered per model and path. The list heads offer Collapse all. A oneOf child list starts with "Chosen by `scheme`" and a tab per variant; a one-value enum (the discriminator inside its variant) reads as a constant, not a list.
- **Required reads as text, not colour.** "Required" is darker and medium weight, "Optional" lighter. The amber column of "required" is gone.
- **One field anatomy.** Label row (name, "i", optional; at the end Clear and the type), control, description, one reserved status line. The description and the status line each have their own line, aligned to the control's start edge; the lookup source moved into the lookup popover. The status line says what will be sent, or the constraints, and the error replaces it, so validation never moves anything. Paired fields share a CSS subgrid, so their rows line up.
- **Enums: a radio group or a select.** Up to 4 values of up to 12 characters are a radio group: every choice visible, a filled dot, an accent border and a tint on the chosen one, roving focus with arrow keys. Anything longer is a select. More than 8 values get a search box. An optional enum shows Clear in its label row when it has a value; a radio group can't be unchecked otherwise.
- **Popovers anchor to their trigger.** Same start edge (the right edge in RTL), at least the trigger's width (and 16rem), below it, or above when there's no room; the list gives up height before the popover passes the viewport. On a phone (56rem and narrower) a select, the lookup and the language picker are a bottom sheet instead: a grab handle, the field's name and description as the title, Close, search for long lists and safe-area padding, so the sheet never covers its own trigger.
- **Selects look like inputs.** The value fills the field; the trigger is a joined segment behind a divider, part of the control (it tints on hover and open, and its chevron turns). The popover is a listbox (APG select-only combobox: focus stays on the control, `aria-activedescendant` moves) with type-ahead, "Any" first for optional fields, a check on the chosen value, and each value's description.
- **Deprecation says what to do.** The notice names the replacements as links (from `x-replaced-by`), the sunset date and how far away it is (from `x-sunset`), and offers one action that opens the replacement with the matching parameters carried over. The same facts appear in Docs and in the sidebar tooltip.
- **The schema match is a detail, not a badge.** It sits in the result's status line after status, time and size, as a quiet toggletip button. A mismatch turns it amber with a count; the toggletip lists each path and why, Pretty marks the lines and Schema tints the rows.
- **Bodies never wrap.** Pretty, Raw and Table scroll sideways; line numbers, the fold column, table headers, row numbers and the name column stay put. Raw has an optional Wrap.
- **Languages show themselves.** The picker lists each language by its own name with the English name and region, the check, and its own number and date format. RTL languages preview a mirrored field before you switch. In RTL, English spec text keeps its direction but lines up with the right edge.

### Spec changes the example API must make

The v5 screens rely on extensions that `spec.js` carries. At implementation, `examples/StoreApi` must emit them, and `node tools/mock-spec.mjs` then snapshots them into `spec.js`:

- `x-replaced-by` on `InventoryController.LegacyStock`: `[{ operationId: InventoryController.Get, parameters: { variantId: $request.path.id }, description: … }, { operationId: InventoryController.List, description: … }]`. A plain operationId string still works (it's what `ui/docs-view.js` reads today).
- `x-sunset: 2027-06-30` on the same operation (optional). The operation should also send a `Sunset` response header (RFC 8594); Sendproof reads it when the spec has no `x-sunset`.
- `x-enum-descriptions` on `CustomerStatus`, `CustomerSegment`, `Currency`, `ShippingMethod`, `OrderStatus`, the inline `currency` and `shippingMethod` of `CreateOrderRequest` and the `sort` parameter of `CustomersController.List`.

### Extra fixes found while redesigning

- **Docs response example matched the wrong data.** List customers showed a page of orders, because any captured page with the same keys matched. Pages now match on their items' required keys too.
- **operationIds in descriptions are links.** "Use `InventoryController.Get`" reads "Use GET Get stock level", linked to the operation.
- **The documented responses before a run were hardcoded to Create order.** They now come from the operation's own responses (List customers shows 200 · 400 · 401).
- **A weekday beside a date was clipped** ("M…") when the wand appeared in a focused date field. It keeps its width.
- **The top bar said v1.0.0** while the spec is 2.0.0; the version now comes from `info.version`. The spec and samples were rewritten for the Acme Store API and every PNG re-rendered, so `screens/` matches the builders.
- **v5.css loads synchronously** (written by `v5-spec.js` before the builders run), so popovers are measured with the v5 layout.
- **"Choose an id…"** now names the record: "Choose a customer…", from the lookup's URL.
- **Popovers stop at the viewport.** The list inside gives up height; search and footer stay visible.
- **The table's first column is the record's name**, sticky beside the row number, so a 15-column page stays readable while scrolling sideways.
- **Key hints are hidden on touch**, where there are no keys.

## v6: data stores (MongoDB Preview, guarded stores and Db command logs)

v6 designs the workbench changes in [`docs/plans/data-stores.md`](../docs/plans/data-stores.md) ("Workbench UI changes") for the protocol in [`spec/data-stores.md`](../spec/data-stores.md). MongoDB gets a full Preview; Redis, DynamoDB, Cassandra, Elasticsearch, OpenSearch, Cosmos DB and Firestore are guarded, so a write blocks the Preview with a 409. Visible branding reads Sendproof. v6 sits on top of v5 and lives in its own files, so earlier screens and `tests/ui/mock-styles.test.mjs` are untouched: `handles.js` writes the v6 scripts in only when the query has `v6=1`, and `v6-stores.js` writes `v6.css`.

### Files (v6)

| File | What it holds |
| --- | --- |
| `v6-icons.js` | Store marks as inline SVG on a 24 grid (`SP.logo(id, size)`), and each store's name, kind, mode and nouns (container, record, key) |
| `v6-stores.js` | The builders (document diff card, SQL row card, store-grouped Database tab, Db command logs) and the four workbench scenes |
| `v6.css` | Mark colours per theme, store groups, the tree diff, command logs, the docked Preview reason, the blocked state, boards, phones and RTL |
| `stores.html`, `v6-board.js` | Boards: every store mark at its sizes, and the five document change kinds |

### Parameters (v6)

`v5=1&v6=1` plus `opid=<operationId>` and `nosql=changes|logs|known|blocked`:

- `changes` with `opid=ShipmentsController.Create`: one Preview that changed 2 SQLite rows and 5 MongoDB documents. `dscroll=orders` brings the orders document to the top.
- `logs` with the same operation: the Logs tab. `open=mongo|redis|dynamo` expands an entry; `copied=cmd` shows the copy feedback.
- `known` with `opid=CartsController.Quote`, marked `preview: false`. `confirm=1` shows Send's confirmation.
- `blocked` with `opid=CouponsController.Redeem`: a Preview stopped by the write guard at Redis `INCRBY`.

Also `theme=dark`, `lang=de|ar`, `text=130` and `mview=result`. Boards: `stores.html?v6=1&set=icons|documents`.

### Screens (v6)

| PNG | Query (`v5=1&v6=1&` plus) | What it shows |
| --- | --- | --- |
| 113-v6-doc-diff | `opid=ShipmentsController.Create&nosql=changes&dscroll=orders` | A MongoDB update as a nested diff with every object open: changed leaves tinted amber with old → new, added green, removed red, a 2 px edge bar on each change, indent guides, "2 changes" on every branch that holds some, typed badges for `ObjectId`, `Decimal128` and `Date`, and `redacted` for secret fields at any depth. The head reads collection, `_id` and counts, with Changes only and Diff · Before · After |
| 114-v6-doc-diff-dark | same `&theme=dark` | The same in dark |
| 115-v6-doc-kinds | `stores.html?v6=1&set=documents` | The five change kinds at the result pane's width: insert, update (arrays by index: a changed package weight, an added package, an added event), upsert ("via upsert" on an insert), replace ("whole document replaced" on an update) and delete |
| 116-v6-doc-kinds-dark | same `&theme=dark` | The same in dark |
| 117-v6-mixed-stores | `opid=ShipmentsController.Create&nosql=changes` | One Preview grouped by store under its mark: SQLite `store-demo.db` (Rolled back, 2 rows) and MongoDB `store` (Transaction aborted, 5 documents). A jump strip at the top, the stores that were only read, and a coverage note that unhooked stores and clients aren't covered |
| 118-v6-mixed-stores-dark | same `&theme=dark` | The same in dark |
| 119-v6-db-logs | `…&nosql=logs&open=mongo&copied=cmd` | Db entries in the log table: a `DB` level, the store mark and name as the source, operation and target in the message. Store chips beside the level filter (SQL, MongoDB, Redis, DynamoDB, with counts), sticky while the log scrolls. The Mongo command as highlighted JSON with `?` placeholder chips, Copy command (copied), and parameters with a redacted `signatureToken` |
| 120-v6-db-logs-dynamo-dark | `…&nosql=logs&open=dynamo&theme=dark` | A DynamoDB `ExecuteStatement`: the PartiQL statement, its two parameters, Copy with values. `GetItem` beside it has no statement, as the spec says |
| 121-v6-db-logs-redis | `…&nosql=logs&open=redis` | A Redis command line: the command, the key kept, every other argument hidden, and why |
| 122-v6-preview-off | `opid=CartsController.Quote&nosql=known` | Preview unavailable, known in advance: Preview keeps its place, disabled with a warn-dashed border; the reason is docked right above it, with a caret to the button. It holds the author's reason (English, as written), why Redis can't Preview, and "Marked by the API author · `preview: false`". Send is primary. The before-run state marks Preview's step unavailable; the sidebar marks the operation |
| 123-v6-preview-off-confirm-dark | `…&confirm=1&theme=dark` | Send still asks first: "Send for real? This writes to Redis and can't be undone." with Cancel and Confirm send |
| 124-v6-preview-blocked | `opid=CouponsController.Redeem&nosql=blocked` | Preview unavailable, caught mid-request (409): a designed state, not an error. What was blocked (Redis `INCRBY`), "Nothing was written" store by store (Redis refused and never sent, SQLite rolled back, side effects discarded), what to do next (Send for real; for the API author, the `preview: false` attribute to copy), and the problem+json body. The action bar remembers "Last Preview blocked · Redis write" |
| 125-v6-preview-blocked-dark | same `&theme=dark` | The same in dark |
| 126-v6-store-icons | `stores.html?v6=1&set=icons` | Every store mark at 14, 16, 20 and 28 px with its `system` id, kind, mode (Preview or Guard only) and nouns, then the marks in place |
| 127-v6-store-icons-dark | same `&theme=dark` | Dark lifts the marks that would sink (SQLite, MySQL, Redis, Elasticsearch's dark band, MariaDB) |
| 128-v6-i18n-de-preview-off | `…&nosql=known&lang=de` | German: the docked reason and the status line wrap and never clip; the author's reason stays English |
| 129-v6-i18n-de-preview-blocked | `…&nosql=blocked&lang=de` | German blocked state |
| 130-v6-rtl-ar-preview-off | `…&nosql=known&lang=ar` | Arabic: the dock mirrors, its caret still points down at Preview (now on the left); `preview: false` and the reason keep their direction |
| 131-v6-rtl-ar-preview-blocked | `…&nosql=blocked&lang=ar` | Arabic blocked state; commands, store names and the JSON stay LTR |
| m26-v6-doc-diff-130 | `…&nosql=changes&dscroll=orders&mview=result&text=130` (320 px) | The diff at 320 px and 130% text: values move under their keys, long ids wrap, the view switch takes its own row and nothing scrolls sideways |
| m27-v6-mixed-stores-130-dark | `…&nosql=changes&mview=result&text=130&theme=dark` (320 px) | Store groups and row cards on a phone, dark |
| m28-v6-db-logs-130 | `…&nosql=logs&open=mongo&mview=result&text=130` (320 px) | Log rows and the command detail on a phone; the filter block stops being sticky, the store chips wrap |
| m29-v6-preview-off-130 | `…&nosql=known&text=130` (320 px) | The docked reason on a phone keeps the title and the author's reason; "Why?" opens the rest |
| m30-v6-preview-blocked-130 | `…&nosql=blocked&mview=result&text=130` (320 px) | The blocked state on a phone |
| m31-v6-preview-blocked-ar-130-dark | `…&nosql=blocked&mview=result&text=130&lang=ar&theme=dark` (320 px) | Arabic, dark, 130%, 320 px |

### Design rules (new in v6)

- **The store's own words.** SQL says table, row and column; MongoDB says collection, document and field; DynamoDB table and item; Redis key prefix and key. Each store group heads its changes with the mark, the store's name as text and its database, so no meaning depends on the logo.
- **Documents open, changes loud.** Every object starts open (the owner's rule for JSON, models and sidebar groups). Unchanged values are plain; changed paths are tinted end to end with a marker in the gutter and a 2 px edge bar, and every branch says how many changes it holds. Inserts and deletes don't tint every line: the whole card is one operation, so only the gutter marks it.
- **Typed values, honest secrets.** Extended JSON reads as a small type badge before the value (`ObjectId`, `Date`, `Decimal128`). `[REDACTED]` is its own dashed, muted pill with a lock, wherever it sits.
- **Commands without values.** Mongo statements show `?` as quiet chips where literals were; Redis keeps the key and hides the rest; parameters list only non-secret names. Copy buttons copy what was captured, never more.
- **Preview unavailable stands out where you'd press it.** Known in advance, the Preview button stays in place (no layout shift between operations), disabled, and the reason is docked directly above it in a warm band with the store's mark. Caught mid-request, the 409 is a designed result in amber, not a red error: what was blocked, that nothing was written, and what to do next.
- **Phones wrap, never scroll sideways.** At 320 px and 130% text the diff stacks values under keys and old over new, chips and log metadata wrap, and the docked reason shortens to its title and reason.

### Open design questions

- **Vendor logos.** The marks are drawn after each official logo for review; the PostgreSQL, MariaDB and SQL Server ones are the roughest. At implementation, use each vendor's own SVG and check its trademark guidelines (the plan's decision "vendor logos versus neutral glyphs"). Redis uses the classic red stack, not the 2024 rebrand.
- **Upsert and replace labels** need the binding to say so: the change record keeps `insert`/`update`, so "via upsert" and "whole document replaced" need an optional field (for example `via: "upsert" | "replace"`), or the UI reads them from the matching command log.
- **Default view.** Updates open on Diff with every object open; Changes only is off. Confirm both defaults.
- **The attribute name.** The snippet shows `[SendproofPreview(Enabled = false, …)]`, assuming the .NET attribute follows the rename.
