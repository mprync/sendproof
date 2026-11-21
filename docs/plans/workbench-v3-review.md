# Workbench v3: first-use review

A review of the live workbench (`http://127.0.0.1:5189/bench/`, Treasury example, signed out and signed in as Ada Admin) from the point of view of a developer opening it for the first time, without docs. It also covers the v2 mocks where the live app follows them. Each issue names the standard it breaks and the v3 mock that fixes it. The mocks were drafted in `mocks/v3/` and, once approved, became the reference set in `mocks/`; their screen list is in [`mocks/README.md`](../../mocks/README.md).

How the review was done:

- Live app in Chromium (Playwright) at 1440×900 and 390×844, at 100% and 130% root text, signed out and signed in. Flows: first load, Create payment with Autofill and Preview, every result tab, List payments while signed out (401), sign-in page, filter with no match, Code tab with an invalid form, keyboard Tab order.
- The owner's screenshots and feedback (F1–F11).
- Root causes from [`workbench-v3-bugs.md`](workbench-v3-bugs.md).

Standards: WCAG 2.2 AA (SC numbers), WAI-ARIA Authoring Practices (APG), ISO 9241-110:2020 interaction principles (suitability for the task, self-descriptiveness, conformity with user expectations, learnability, controllability, use error robustness, user engagement), Nielsen's 10 heuristics (H1–H10), and i18n practice (externalised strings, locale formats, plurals, expansion, RTL).

Severity: **High** blocks a task or excludes users. **Medium** causes errors, confusion or rework. **Low** is polish.

## Summary

The workbench's core idea (Preview rolls back, Send commits) is strong. A first-time user can't see that idea in action, though, because almost everything that explains it is hidden, tiny or missing:

1. **Too small and inconsistent to read.** The live UI uses 13 px text and 36 px controls, and the tab bars differ from one another.
2. **The UI goes silent in its most important moments.** Result tabs are dead before a run and disappear after a 401. Copy gives no feedback. A clipboard error replaces the result pane. Sign-in fails with "Sign in failed (500)".
3. **The OpenAPI document is barely used.** Descriptions, constraints, examples, response codes, security requirements, deprecation and every schema exist in the spec but are invisible.

v3 fixes all three without changing the look. The type and size tokens grow, one tab component is used everywhere, and every state explains itself. The spec gets a Docs view, field toggletips and a Models section.

## Findings

| # | Issue (observed) | Standard or heuristic broken | Severity | Fixed in |
| --- | --- | --- | --- | --- |
| 1 | Body text is 13 px, controls 36 px, keycaps 18 px and icons 14 px. At 1440 px it reads as dense and is tiring to scan; there is no density choice. (F1) | ISO 9241-110 suitability for the task; H8 aesthetic and minimalist design (legibility); WCAG 1.4.4 Resize Text (works, but only by zooming the whole page) | High | 01, 02, 03, 04, 05 |
| 2 | Send shows three separate keycaps (⇧ ⌘ ↵), so the button is cramped and wider than Preview. (F2) | H8 minimalist design; H4 consistency (Preview has two keycaps, Send has three) | Medium | 01, 06, 45 |
| 3 | After a 401 the result pane hides every tab with a 0 count, leaving Response and Headers far apart. Database, Side effects and Logs vanish. (F3) | H1 visibility of system status; ISO 9241-110 conformity with user expectations; WCAG 3.2.3 Consistent Navigation | High | 11, 12, 43, m04 |
| 4 | Result tabs are `aria-disabled` before a run, and clicking does nothing. Nothing says what each tab will show or how to fill it. (F4) | H10 help and documentation; H6 recognition rather than recall; ISO 9241-110 self-descriptiveness; APG Tabs (disabled tabs should stay focusable and explain themselves) | High | 07, 08, 42, m03 |
| 5 | Copy buttons (URL, cURL, body, line, SQL, headers, code) give no visible feedback. Only an `sr-only` region changes. (F5) | H1 visibility of system status; WCAG 4.1.3 Status Messages (announced, but sighted users get nothing) | Medium | 17, 18, 44 |
| 6 | When the clipboard is blocked, Copy URL and Copy code replace the whole result pane with "Unable to complete request". Other copy buttons fail silently. | H9 help users recognise, diagnose and recover from errors; ISO 9241-110 use error robustness (an error destroys unrelated work) | High | 19, 21, 44 |
| 7 | Sign-in fails with "Sign in failed (500)" and no explanation or next step. A wrong password shows "Sign in failed (401)". (F6) | H9 error recovery; WCAG 3.3.1 Error Identification, 3.3.3 Error Suggestion; ISO 9241-110 self-descriptiveness | High | 14, 15, 16, m09 |
| 8 | Signed out, nothing says which operations need sign-in. Operations run and return a bare 401 "No response body." with no way forward. (F6) | H1 visibility of status; H9 error recovery; ISO 9241-110 suitability for the task | High | 09, 10, 11, 48 |
| 9 | The sign-in page has no way back to the workbench and no header context. | H3 user control and freedom; WCAG 2.4.5 Multiple Ways | Medium | 14, 16 |
| 10 | Request tabs differ: Body reserves an invisible badge, so "Body" sits wider than the others. Request and result tab bars use different padding and badge sizes; result tabs spread out after an error. (F7) | H4 consistency and standards; ISO 9241-110 conformity with user expectations | Medium | 01, 22 (one `.tab` everywhere) |
| 11 | The validation banner breaks: its title wraps one word per line in a narrow column and the message is a run-on "field: This field is required." list. (Owner screenshot) | H8 minimalist design; H9 error messages in plain language; WCAG 3.3.1 Error Identification | High | 22 |
| 12 | Validation messages are generic ("This field is required."). They don't say what to enter. | WCAG 3.3.3 Error Suggestion; H9 | Medium | 22 |
| 13 | No endpoint documentation. The spec's summary, description, tags, deprecation, security requirements, parameter descriptions, examples, enums, constraints and response codes aren't shown. (F8) | H10 help and documentation; ISO 9241-110 self-descriptiveness and learnability | High | 23, 24, 25, 26, m05, m07 |
| 14 | No schema or model viewer. `CreatePaymentRequest` is printed as plain text and can't be opened. $refs, oneOf and discriminators are invisible. (F9) | H6 recognition rather than recall; H10 documentation | High | 27, 28, 29, 30, m08 |
| 15 | The wand on a field is an `aria-hidden` status icon with no handler. It looks clickable but does nothing. (F11) | H4 consistency (an affordance that does nothing); WCAG 4.1.2 Name, Role, Value (not a control) | Medium | 31, 32, m06 |
| 16 | "Fill required fields" uses fixed values: amount 0.01, today's date (often not a business day) and `person@example.com`. Previews look fake and often fail business rules. | ISO 9241-110 suitability for the task; H2 match with the real world | Medium | 32, 31 |
| 17 | While the form is invalid, the Code tab shows validation text instead of a snippet, and Copy copies that text. | H5 error prevention; ISO 9241-110 suitability for the task | Medium | 20, 21 |
| 18 | The Code tab's language picker and Copy button are full-width native controls, unlike every other toolbar. | H4 consistency | Low | 20 |
| 19 | Preview is disabled on GET and auth operations with no reason given. A user can't tell whether it's broken. | H1 visibility of status; WCAG 3.3.2 Labels or Instructions; ISO 9241-110 self-descriptiveness | Medium | 33 |
| 20 | Filter with no matches leaves an empty sidebar: no message, no clear action. (F10) | H1; H9 | Medium | 34, 43 |
| 21 | Empty states are missing or inconsistent: two different "empty result" texts for different operations, no empty history, no empty headers state, no logs-filtered state, a bare "No response body." (F10) | H4 consistency; H10 help | Medium | 07, 35, 36, 37, 38, 42, 43 |
| 22 | Loading and failure states don't cover the spec failing to load or the API being unreachable. | H1; H9; owner standard (loading mirrors layout) | Medium | 39, 40, 41 |
| 23 | Blank optional fields reserve an empty assist line. Fields without hints leave visible gaps, so field spacing looks uneven. | H8 aesthetic design (rhythm); Gestalt proximity | Low | 07, 09 (every field has a hint) |
| 24 | Required fields aren't explained. Only optional ones are marked, and nothing tells a first-time user that unmarked means required. | WCAG 3.3.2 Labels or Instructions | Medium | 01 ("Fields are required unless marked optional") |
| 25 | The currency in Amount defaults to "Select…" even though the enum and example give EUR. | H5 error prevention; ISO 9241-110 suitability for the task | Low | 01, 07 |
| 26 | The value date shows no weekday or relative hint, so non-business days are easy to pick. | H5 error prevention; H2 real world | Low | 01 (weekday, "In 3 days · business days only") |
| 27 | First load opens "Sign in with a password", even when signed in. There's no overview of the API or of what Preview and Send do. | H10 help; ISO 9241-110 learnability and suitability; H2 match with the real world | Medium | 48 |
| 28 | The mobile Request/Result switch stretches into a large empty box above the form (the grid gives it the flexible row). | H8; WCAG 1.4.10 Reflow | High | m01, m03 |
| 29 | On mobile, Preview is disabled with no reason and the action bar loses its status line. | H1; WCAG 3.3.2 | Medium | m01, 33 |
| 30 | At 130% text the Autofill label disappears, leaving an unlabelled wand next to Form/JSON, and the status line vanishes. | WCAG 1.4.4 Resize Text; 1.4.12 Text Spacing; H6 | Medium | m02, 45 (Form/JSON moved to the Body section; the bar wraps to two lines) |
| 31 | Long sidebar names truncate ("Switch to a development p…") with no full name on hover or focus. | WCAG 1.4.13 Content on Hover or Focus; H6 | Low | 01 (titles; deprecation as an icon, not a text tag) |
| 32 | The Logs table and its footer overflow the pane ("exp…" cut off) and the filter placeholder is clipped. | WCAG 1.4.10 Reflow; H8 | Low | 18, 37 |
| 33 | Status after a run shows "0 B" and "8 ms" in hard-coded English units; metrics and counts don't follow a locale. | i18n: locale-aware numbers and units | Low | 45, 46 (`Intl` units) |
| 34 | All strings are hard-coded English in the UI modules; no plural rules ("1 operations" risk), no locale number or date formats in inputs, and placeholders like `dd/mm/yyyy` are fixed. | i18n: externalised strings, pluralisation, locale formats; WCAG 3.1.1 Language of Page | Medium | 45, 46, m10, m11 (`i18n.js`) |
| 35 | The layout uses physical properties (left/right margins, `text-align: left`), so an RTL locale would not mirror. | i18n: RTL with logical properties | Medium | 46, 47, m11 |
| 36 | Spec text (summaries, field titles) isn't marked with its language, so a screen reader in another locale reads English with the wrong voice. | WCAG 3.1.2 Language of Parts | Low | 45, 46 (`lang="en"` on spec text) |
| 37 | Shortcut hints are Mac-only glyphs. Windows users see ⌘ and ⌥. | H2 match with the real world; H4 platform conventions | Medium | 45 (Ctrl chords; long form in tooltips) |
| 38 | Send after Preview shows no explanation of why Database and Side effects are empty (they aren't captured on Send). | H1; ISO 9241-110 self-descriptiveness | High | 13 |
| 39 | Hover-only explanations: the wand's title "Autofilled" and lock tooltips appear only on mouse hover. | WCAG 1.4.13 Content on Hover or Focus; 2.1.1 Keyboard | Medium | 23 (toggletip opens on focus and click, Esc closes) |
| 40 | Counts and issue badges change tab widths when they appear, shifting the next tab. | Owner standard: no layout shift; WCAG 2.5.8 (moving targets risk mis-taps) | Medium | 01, 07, 22 ("–" placeholders, overlay dot) |
| 41 | A 401 result's response body is "No response body." with no `WWW-Authenticate` or retry guidance in view. | H9; H1 | Medium | 11 |
| 42 | The headers editor with no custom headers shows one empty "Add header" row and "0 headers will be sent", even though Test Bench sends managed headers. | H1; H2 match with the real world | Low | 36 |
| 43 | Captured database values are shown as raw strings but inputs aren't localised either, so the two can't be told apart. There's no rule for which data follows the locale. | i18n: separate data from presentation | Low | 45, 46 (data invariant, chrome localised) |
| 44 | Small targets: 24–28 px icon buttons in the URL bar, viewer bars and header rows on mobile. | WCAG 2.5.8 Target Size (Minimum) is met at 24 px; owner standard is 44 px on mobile | Medium | m01–m11 (44 px on mobile) |
| 45 | No density or text-size setting, and no visible statement that the UI follows browser zoom. | ISO 9241-110 controllability; user engagement | Low | 05 |

## Decisions for the owner

1. **Default density.** v3 makes Default 15 px text and 40 px controls, with Compact (14 px, 34 px) and Comfortable (16 px, 44 px) in Display settings. Is Default right, or should Compact be the default for laptop users?
2. **Docs is a view, not a tab.** Try it and Docs are two views of an operation (D switches between them). Docs takes the request and result panes for a reading layout with samples on the side. The alternative is a sixth request tab, which keeps the result pane visible but is cramped.
3. **Models live in the sidebar** as a second tab next to Operations. They're also reachable from type links and the response Schema view. Is a sidebar tab right, or should Models be a separate top-level route?
4. **Traced Send.** Mock 13 offers "Turn on traced Send" to capture database changes and effects on Send. That needs the observed-send server work from the v2 plan (Track A item 5). Should it be on by default in Development?
5. **Invalid values in the wand menu.** The Generate menu offers values that break the schema, so the API's 400s can be tested. Keep that, or hide it behind a setting?
6. **Data stays invariant.** Captured rows, JSON, SQL and headers show stored values (`50000.00`), while inputs and prose follow the locale (`50.000,00`). Confirm this rule.
7. **Arabic digits.** The RTL mock uses `ar-EG` (Arabic-Indic digits). Many Arabic-speaking developers prefer Latin digits; this could be a per-user choice.
8. **GET has no Preview.** A read-only GET shows one primary Send. Confirm, or keep Preview for GETs that the API marks as having side effects.
