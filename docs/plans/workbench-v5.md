# Workbench v5: design decisions and implementation plan

v5 answers the owner's review of the live v4 app. It takes the reading experience of Stripe's API reference and fits it to our design system (Geist, OKLCH neutrals at hue 268, the accent, both themes), and it redesigns the form controls, the response viewer and the language picker.

**Status (2026-11-21): implemented in `ui/`.** See the v5 entry in [`workbench-v2-progress.md`](workbench-v2-progress.md). The approved reference is the v5 section of [`mocks/README.md`](../../mocks/README.md): screens `76`–`110` and `m18`–`m24`, rendered by `node tools/shoot-mocks.mjs v5`. This plan records why each decision was made and what changes in `ui/`. It doesn't repeat the screen list.

Standards that apply to every item: keep every existing feature, no layout shift, WCAG 2.2 AA, WAI-ARIA Authoring Practices patterns, Nielsen's heuristics, i18n with RTL and 130% text, and loading, empty and error states that mirror the final layout.

## Contents

1. [Enum fields](#1-enum-fields-radio-group-or-select)
2. [Selects and the ID lookup](#2-selects-and-the-id-lookup)
3. [UI languages](#3-ui-languages)
4. [Model viewer and Docs schemas](#4-model-viewer-and-docs-schemas)
5. [Deprecated operations](#5-deprecated-operations)
6. [Field anatomy](#6-field-anatomy)
7. [Response toolbar and schema match](#7-response-toolbar-and-schema-match)
8. [Response views](#8-response-views-pretty-raw-table-schema)
9. [Extra fixes](#9-extra-fixes)
10. [Spec changes](#10-spec-changes-in-the-example-api)
11. [Files that change](#11-files-that-change)
12. [Tests](#12-tests)

## 1. Enum fields: radio group or select

**Problem.** `status` (Open / Frozen / Closed) rendered as a segmented control. Its selected state is a slightly raised background, which is close to invisible in dark and doesn't read as "chosen" in light. An optional enum couldn't be unset.

**Decisions**

- **Up to 4 values of up to 12 characters are a radio group.** Every option is visible and one click away (Nielsen: recognition over recall). Anything larger is a select (item 2).
- **The chosen option has three cues, none of them colour alone:** a filled radio dot, an accent border (2 px effective) and a tint. Text goes to medium weight. The dot border uses `--text-3`, which keeps 3:1 against the control in both themes (WCAG 1.4.11).
- **Options are separate buttons, not a joined bar**, so the group reads as "pick one" rather than as tabs.
- **Unset is a real state.** No option is checked, the status line says "Not sent while unset", and a checked optional group shows **Clear** in its label row. A native radio group can't be unchecked, so Clear is the only way back.
- **Long values wrap to the next line** in a narrow pane; they never truncate. On a phone the options grow to fill the row.
- **Keyboard:** WAI-ARIA radio group, roving tabindex, arrow keys move and select, Delete clears when the field is optional.

**Checklist**

- [x] `ui/fields/controls.js` `enumControl`: render `role="radiogroup"` with `role="radio"` options for short enums; call the select for the rest. Thresholds in one place (`useRadio`: ≤ 4 values, each ≤ 12 characters).
- [x] Roving tabindex and arrow-key selection; Delete or Backspace clears optional fields.
- [x] Clear in the label row (see item 6) for optional radio groups with a value.
- [x] Error state: option borders take `--danger-line`; the message takes the status line.
- [x] Disabled state: sunken background, no shadow, value still visible.
- [x] Remove the `.segmented.lg` enum styling from fields once nothing uses it (keep `.segmented` for view switches).

## 2. Selects and the ID lookup

**Problem.** `type`, `currency` and `sort` used a native `<select>` drawn as a small box inside the input. It looked broken, showed no descriptions, couldn't be searched and couldn't be cleared clearly.

**Decisions**

- **A select looks like an input.** The value fills the field; the trigger is a joined segment behind a 1 px divider, part of the control. It tints on hover and open, and its chevron turns when open. The status slot (error icon) stays reserved, so nothing moves.
- **The popover is a listbox**, following the APG select-only combobox: focus stays on the control, `aria-activedescendant` moves through options, Enter chooses, Esc closes, Home and End jump, and type-ahead matches the start of a value (the footer echoes what was typed).
- **Optional selects start with "Any"**, which means "not sent". It carries the check when unset, and choosing it clears the field. Clear is also in the label row.
- **Each value shows its description** from `x-enum-descriptions`, on its own line under the value.
- **More than 8 values get a search box** that matches values and descriptions ("kr" finds krona and krone), with a match count and a "Nothing matches" row. The search box has one control: Esc clears it, with no separate × (owner preference).
- **The ID lookup uses the same control and popover.** The value is the record's name with its detail (IBAN) in mono. The popover has search by name, detail or ID; "From the last response" first; then every record with its currency and a quiet tag for non-default status; then "Paste an ID" (⌘V) and "Use a random UUID" (to test 404). The placeholder names the record ("Choose an account…"), derived from the `x-lookup` URL.
- **The lookup's source lives in the popover footer**: `GET /api/v2/accounts?pageSize=100 · as Ada Admin · 25`, with Refresh. This fixes item 6.
- **Lookup states mirror the loaded layout:** loading shows skeleton rows of the same shape; empty says who can't see what and offers the create operation; error names the request and status code with Retry; signed out explains why and offers Sign in. Paste works in every state.
- **Popovers are anchored and compact:** the trigger's start edge (the right edge in RTL), at least the trigger's width (min 16rem, never capped below it), flip above when there's no room below, and never pass the viewport: the list gives up height, search and footer stay.
- **On a phone (≤ 56rem) the listbox is a bottom sheet:** grab handle, the field name and description as the title, a 44 px Close, search for long lists, `env(safe-area-inset-bottom)` padding (with `viewport-fit=cover`), a scrim, and focus trapped in the sheet. It never covers its trigger. The lookup and the language picker use the same sheet.
- **The lookup footer is one line:** icon, `GET /api/v2/accounts`, "· as Ada Admin · 25", Refresh. The query string truncates first, then the path; the full request is the title. On a phone "as Ada Admin" drops.
- **The wand stays.** ⌥G still generates a random value for a select or lookup, and Autofill fills them; the status line then says "Generated: …" with Undo.

**Checklist**

- [x] New `ui/fields/select.js`: field-styled combobox, listbox popover, type-ahead buffer (500 ms), search above 8 options, "Any" row for optional fields, descriptions, check, keyboard model.
- [x] `ui/fields/controls.js`: use it for every enum that isn't a radio group, and for the currency segment of money fields (`x-currency-field`).
- [x] `ui/fields/lookup.js` and `ui/fields/lookup-source.js`: render through the same control and popover; groups (last response, all records, paste and random); footer source with Refresh; loading, empty, error and signed-out states.
- [x] `ui/popover.js`: start-edge anchoring (RTL-aware), at least the anchor's width, flip, viewport clamp that shrinks the list; a bottom-sheet mode below 56rem with grab handle, title, Close, scrim, focus trap and safe-area padding.
- [x] Touch: 44 px options, no key-hint footer, Clear with a 44 px hit area.
- [x] Remove the native `<select>` path and its CSS once every enum renders through the new control.

## 3. UI languages

**Problem.** Display settings offered 4 languages (`ui/i18n.js` `LANGUAGES`: English Ireland and US, Deutsch, العربية), as a plain button.

**Decisions**

- **34 languages in six groups**, each listed by its autonym, with the English name and region beneath, a check on the current one, and a sample of that locale's number and date format ("1.250,00 · 23.11.2026"), so the user sees what changes before choosing.
- **Search covers autonyms, English names, regions and codes** ("he" finds עברית and Nederlands via "Netherlands").
- **RTL languages carry a small RTL tag and preview a real field, mirrored,** at the bottom of the picker while they're the active row.
- **The picker is a listbox popover anchored to a field-styled Language control** in Display settings, the same component as item 2.
- **Spec text stays as written** (`lang="en"`), as in v4. In RTL it keeps its direction but lines up with the right edge, so a description sits under its attribute name.
- **Fonts:** Geist first, then Noto Sans JP, Noto Sans Hebrew (and the existing IBM Plex Sans Arabic) per script, plus Noto Sans for Devanagari and Thai, Noto Sans KR and Noto Sans SC/TC at implementation. CJK uses line height 1.6.
- **Button widths stay per locale** (`widths` in each catalogue), so Preview and Send never move.

**Locale list (`LANGUAGES`)**

| Group | Locales |
| --- | --- |
| English | `en-IE` (default), `en-GB`, `en-US`, `en-CA`, `en-AU`, `en-IN` |
| Western Europe | `de-DE`, `fr-FR`, `es-ES`, `it-IT`, `nl-NL`, `pt-BR`, `pt-PT` |
| Nordic | `da-DK`, `nb-NO`, `fi-FI`, `sv-SE` |
| Central and Eastern Europe | `cs-CZ`, `el-GR`, `pl-PL`, `ru-RU`, `tr-TR`, `uk-UA` |
| Middle East, right to left | `ar`, `fa-IR`, `he-IL` |
| Asia | `hi-IN`, `id-ID`, `ja-JP`, `ko-KR`, `th-TH`, `vi-VN`, `zh-Hans`, `zh-Hant` |

English variants share the `en` catalogue and differ only in `Intl` formatting; `pt-BR` and `pt-PT` need separate catalogues; `zh-Hans` and `zh-Hant` are separate catalogues.

**Checklist**

- [x] `ui/i18n.js`: the 34-entry `LANGUAGES` (id, autonym, English name, region, catalogue, `dir`, button widths); `detectLanguage` keeps exact match, then base language, then `en-IE`.
- [x] `ui/locales/<id>.js` and `<id>-capture.js` for each catalogue; plural rules through `Intl.PluralRules` (Arabic six forms, Polish, Czech, Russian and Ukrainian three or four, CJK one).
- [x] `ui/display-settings.js`: the Language row becomes the field-styled control; the picker uses the listbox popover with search, groups, samples, check, RTL tag and RTL preview.
- [x] Fonts per `:lang()` in `ui/styles.css`, loaded only for the active script.
- [ ] Translation review by native speakers before a locale ships; until then it stays behind a "preview" flag. (Open: the 26 new catalogues and the v5 strings in `de` and `ar` are machine-translated; the picker tags them Preview, see `ui/locales/README.md`.)
- [x] Check 130% text and 320 px width for the longest locales (German, Finnish, Greek) and for CJK.

## 4. Model viewer and Docs schemas

**Problem.** Leaf properties had too much padding and indentation: each was a tall boxed row with an empty chevron column, constraints were chips and enum values a row of chips. Every row carried an amber "required" at the far end.

**Decisions (Stripe reading style)**

- **Flat rows separated by hairlines**, no boxed card around the list. A section heading, then the list.
- **Row:** name in bold mono, the type in muted text (a model is a link; `nullable string`, `array of Approval`, `one of 3`), then "Required" or "Optional" on the same line. **Required reads as text, not colour:** darker and medium, Optional lighter.
- **The description sits beneath, flush with the name.** Leaf rows have no toggle column and no indent.
- **Constraints are quiet inline text:** "Format `uuid`   Max length `42`   Pattern `^…$`   Default `25`".
- **Enums list "Possible enum values"** with descriptions; without descriptions a compact inline list; past 6 values, "Show N more values". A one-value enum (a discriminator inside its variant) is a constant: "Always `Iban` in this variant", unless the description already says so.
- **Nested objects use "Show child attributes"**, a small pill that, opened, becomes the head of a bordered, inset child list. Child lists nest. Everything starts open, three levels deep (owner decision: expanded by default, collapsible, as with JSON and the sidebar); what the user closes is remembered per model and path; the list heads offer Collapse all; `$ref` cycles stop with "recursive".
- **oneOf inside a list:** the child list starts with "Chosen by `scheme`" and a tab per variant (the one tab component), then the variant's rows.
- **Vertical rhythm:** 14 px row padding, 4 px from name to description, 5 px to the constraints line. Compact rows (8 px) only in the response Schema view.
- **One renderer for every place:** model pages, Docs parameters, request bodies, responses and the response Schema view.

**Checklist**

- [x] `ui/schema-tree.js`: replace `row`, `rows`, `variantRows` and `chipsFor` with the attribute-list renderer (`attrs`, `attrRow`, `variants`, `facts`, `enumBlock`); keep `propertyTree` and `parameterTree` as the entry points so callers don't change.
- [x] `ui/schema-model.js`: expose enum descriptions (`x-enum-descriptions`, also `oneOf` of `const` with `description`) and one-value enums as constants.
- [x] `ui/model-view.js`: flat sections; enum pages as "Possible enum values".
- [x] `ui/docs-view.js`: parameters, body and responses use the same list; the v4 cards flatten into a heading and hairlines.
- [x] Collapsed paths are remembered per API and model in local storage (not the URL); Collapse all and Expand all in each list head.
- [x] Delete the chip styles (`.chip`, `.sr-*`) once nothing renders them.

## 5. Deprecated operations

**Problem.** "Get account balance" said "Deprecated. It may be removed in a later version" with no guidance, although the description names the replacements and `ui/docs-view.js` already reads `x-replaced-by`.

**Decisions**

- **One notice in Try it and Docs:** "Deprecated · Stops working on 30 June 2027 · in 7 months", "Use instead:", each replacement as a link with its method and why (from `x-replaced-by`), and one action, "Open Get balance" (Try it) or "Try Get balance" (Docs), that opens the first replacement with matching parameters carried over: "Carries over `id` as `accountId`".
- **Parameter mapping uses OpenAPI runtime expressions** (`$request.path.id`), as an OpenAPI Link object does. Without a mapping, parameters with the same name, or the same format and `x-lookup` URL, carry over.
- **Sunset:** `x-sunset` first, else the last response's `Sunset` header (RFC 8594), else "No sunset date in the spec".
- **Sidebar:** the strikethrough and warning marker stay; the row's tooltip says "Deprecated · sunset 30 Jun 2027 · Use Get balance or List balances."
- **operationIds named in descriptions become links** with the method and summary (item 9).

**Checklist**

- [x] `ui/docs-view.js` `deprecation`: read `x-replaced-by` as a string or a list of `{ operationId, parameters, description }`, and `x-sunset`; render the notice.
- [x] `ui/operation-header.js`: the same notice in Try it; the action navigates with the carried values (`ui/navigation.js`, `ui/router.js`).
- [x] `ui/sidebar.js`: tooltip for deprecated rows.
- [x] `ui/result-headers.js` or `ui/response-metadata.js`: capture `Sunset` and `Deprecation` headers for the fallback.

## 6. Field anatomy

**Problem.** Under the `id` lookup, "The account's ID." and "Options from GET /api/v2/accounts?pageSize=100, as Ada Admin sees them" ran together on one line with a database icon between them.

**Decisions**

- **Four parts, the same for every field type:** label row (name, "i" toggletip, "optional"; at the end Clear and the type), control, description, status line.
- **The description has its own line(s)**, from the spec, aligned to the control's start edge. It's static, so it never shifts anything.
- **The status line is one reserved line**: constraints ("1 to 100 · Default 25"), what will be sent ("Sends `status=Open`", "Sends `e25dbc9d…e3dd`", "Not sent while unset"), or the character count. An error or "Generated: … Undo" replaces it, so validation never moves the form.
- **The lookup source moves into the popover footer** (item 2).
- **Paired fields share a subgrid**, so label rows, controls, descriptions and status lines line up across a row whatever each description's length.
- **Spacing:** 6 px label to control, 7 px to the description, 2 px to the status line, 12 px between fields.

**Checklist**

- [x] `ui/fields/render.js`: one field template with the four parts; the description element always exists (empty when the spec has none) so the subgrid has four rows.
- [x] `ui/fields/validate.js`, `ui/issues.js`: messages go to the status line; `aria-describedby` lists description and status.
- [x] `ui/field-help.js`, `ui/toggletip.js`: unchanged content, new placement in the label row.
- [x] `ui/styles.css`: `.fields` grid with `grid-template-rows: subgrid` per field; status line `min-block-size: var(--assist-h)`.
- [x] Every control type renders through the template: text, number, password, date, money, select, radio group, lookup, list.

## 7. Response toolbar and schema match

**Problem.** The "✓ Matches Account" pill sat beside Pretty / Raw / Table / Schema and pushed search and copy onto a second row. A mismatch had no way to show why.

**Decisions**

- **The toolbar is one line at every width:** views at the start, icon actions at the end (Collapse all, Wrap in Raw, Search, Copy). In a narrow pane, labels give way to icons with tooltips (container query at 26rem).
- **The schema match moves to the result's status line**, after status, time and size: a small, quiet "✓ Matches schema" toggletip button. Its toggletip says which schema and what was checked (types, formats, patterns, lengths, enums, required).
- **Mismatch:** the button turns amber with a count ("⚠ 3 schema issues"). The toggletip lists each path and why, notes that the response is shown exactly as received, and offers "Show in Schema view" and "Copy issues". Pretty marks the affected lines with a quiet reason at the line end; Schema tints the rows with the reason and lists undocumented properties as "Not in the schema".
- **On a phone** the status line wraps: status, code, metrics and match, then Copy as cURL at the end of the second line.

**Checklist**

- [x] `ui/response-metadata.js`: match state and issue list from the existing validation (`validationMarkup` in `ui/response-viewer.js`).
- [x] `ui/results.js`: the match button in the head row, its toggletip.
- [x] `ui/response-viewer.js` `responseMarkup`: one-line toolbar; container query for labels.

## 8. Response views: Pretty, Raw, Table, Schema

**Problem.** Text wrapped; the Schema view had the model viewer's extra left padding; its legend wrapped onto three lines.

**Decisions**

- **No wrapping anywhere.** Long lines scroll sideways; line numbers and the fold column are sticky.
- **Raw is the bytes as received**, monospace, one line for compact JSON, with an optional Wrap toggle (⌥Z) and a footer: "1 line · 0.3 kB · application/json; charset=utf-8, exactly as received".
- **Table is a real table:** sticky header, sticky row numbers, an edge fade while columns remain off to the side and "15 columns, scroll →" in the footer (it scrolls one screen), a shadow on the sticky name column once scrolled, the record's label field (from `x-lookup`'s `labelField`, else `name`) first and sticky, numbers right-aligned in tabular figures, `null` muted, nested values as "3 keys" buttons, and a footer with rows, columns and the page. A single object is a Field / Value table.
- **Schema is the attribute list in compact rows** with a presence dot at the line end (never an indent), and a one-line legend: "● Returned  ○ Not returned  ◆ Doesn't match   Account →".

**Checklist**

- [x] `ui/response-viewer.js`: `lineMarkup` without wrapping, sticky gutter; `tableRows` and `tableMarkup` for list pages (columns from the item schema), label column first; Raw with Wrap; `schemaMarkup` through the attribute list in compact mode with `presentPaths`.
- [x] `ui/views.css`: `.vb5-body`, `.raw5`, `.tbl5`, `.legend5` equivalents.
- [x] Search (⌘F) keeps working in all four views.

## 9. Extra fixes

Found while redesigning; each is in the v5 screens.

- **Docs response example matched the wrong data.** List accounts showed a page of payments, because any captured page with the same keys matched. Match list pages on their items' required keys too (`ui/docs-view.js` sample picking).
- **operationIds in descriptions become links** with method and summary (`ui/markdown.js`).
- **Documented responses before a run** come from the operation's own responses, not a fixed list.
- **A weekday beside a date was clipped** when the wand appeared; the trailing text keeps its width.
- **"Choose an id…" names the record:** "Choose an account…", from the `x-lookup` URL.
- **Popovers stop at the viewport**; the list shrinks, search and footer stay.
- **Key hints are hidden on touch.**
- **The top bar's version comes from `info.version`** (the mocks hardcoded v1.0.0 against a 2.0.0 spec; check `ui/` does the same).

## 10. Spec changes in the example API

`examples/TreasuryApi` must emit these; `mocks/v5-spec.js` adds them to the snapshot until it does. After the change, run `node tools/mock-spec.mjs` and delete the patch from `v5-spec.js`.

```yaml
/api/v2/accounts/{id}/balance:
  get:
    deprecated: true
    x-replaced-by:                    # or a single operationId string
      - operationId: BalancesController.Get
        parameters: { accountId: $request.path.id }
        description: The same account, with the ledger and reserved amounts too.
      - operationId: BalancesController.List
        description: Every account's balance in one call.
    x-sunset: 2027-06-30              # optional; also send a Sunset response header
components:
  schemas:
    AccountStatus:
      x-enum-descriptions: { Open: Sends and receives payments., Frozen: Receives payments but can't send them., Closed: No longer used. Kept for history. }
```

`x-enum-descriptions` also goes on `AccountType`, `Currency`, `Priority`, `PaymentStatus`, the inline `currency` and `priority` of `CreatePaymentRequest`, and the `sort` parameter of `AccountsController.List`. The values are in `mocks/v5-spec.js`. In ASP.NET, a schema transformer can read them from `[Description]` attributes on enum members.

## 11. Files that change

| Area | `ui/` files |
| --- | --- |
| Field anatomy, radio group, select, lookup | `fields/render.js`, `fields/controls.js`, new `fields/select.js`, `fields/lookup.js`, `fields/lookup-source.js`, `fields/validate.js`, `issues.js`, `popover.js`, `field-help.js`, `generate-menu.js` (wand on selects) |
| Attribute list | `schema-tree.js`, `schema-model.js`, `model-view.js`, `docs-view.js`, `markdown.js` |
| Deprecation | `docs-view.js`, `operation-header.js`, `sidebar.js`, `navigation.js`, `router.js`, `response-metadata.js` |
| Response viewer | `response-viewer.js`, `results.js`, `response-metadata.js` |
| Languages | `i18n.js`, `locales/*`, `display-settings.js` |
| Styles | `styles.css`, `views.css`, `app.css` (then copy `ui/styles.css` to `mocks/styles.css` so `tests/ui/mock-styles.test.mjs` holds, and fold `mocks/v5.css` into them) |
| Adapters | the bundled copies of `ui/` in `adapters/*` are regenerated by `tools/pack-ui.mjs` |

## 12. Tests

- [x] `ui/schema-tree.test.mjs`: attribute rows, one-value enum as constant, child lists, cycles, compact mode with presence and issues.
- [x] `ui/request-editor.test.mjs`: radio group versus select thresholds, Clear, "Any", type-ahead, search above 8 values, lookup states.
- [x] `ui/response-viewer.test.mjs`: no wrapping, table columns from the item schema, label column first, Raw footer, mismatch markers.
- [x] `ui/i18n.test.mjs`: 34 languages, `detectLanguage` fallbacks, plural forms, RTL `dir`.
- [x] `ui/docs-view` tests: `x-replaced-by` string and list forms, parameter carry-over, `x-sunset` and the `Sunset` header fallback.
- [x] `tools/shoot-mocks.mjs` stable-shell check still passes; accessibility pass with axe on screens 76, 91, 100 and 107 in both themes and RTL.
