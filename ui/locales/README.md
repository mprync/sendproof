# UI catalogues

Test Bench translates only its own interface. Text from the OpenAPI document and captured data
is shown as written. `ui/i18n.js` lists the 34 UI languages (`LANGUAGES`) and loads one
catalogue at a time; English is bundled and every missing key falls back to it.

## Files

Each catalogue is two files: `<catalogue>.js` (the main strings, `dir`, the Send and Preview
button `widths` and the date-pattern `dateLetters`) spreads `<catalogue>-capture.js` (the
result panes, the headers editor, issues and validation). English variants (`en-IE`, `en-GB`,
`en-US`, `en-CA`, `en-AU`, `en-IN`) share `en` and differ only in `Intl` formatting.

| Group | Languages → catalogue |
| --- | --- |
| English | en-IE, en-GB, en-US, en-CA, en-AU, en-IN → `en` |
| Western Europe | de-DE → `de`, fr-FR → `fr`, es-ES → `es`, it-IT → `it`, nl-NL → `nl`, pt-BR → `pt-BR`, pt-PT → `pt-PT` |
| Nordic | da-DK → `da`, nb-NO → `nb`, fi-FI → `fi`, sv-SE → `sv` |
| Central and Eastern Europe | cs-CZ → `cs`, el-GR → `el`, pl-PL → `pl`, ru-RU → `ru`, tr-TR → `tr`, uk-UA → `uk` |
| Middle East, right to left | ar → `ar`, fa-IR → `fa`, he-IL → `he` |
| Asia | hi-IN → `hi`, id-ID → `id`, ja-JP → `ja`, ko-KR → `ko`, th-TH → `th`, vi-VN → `vi`, zh-Hans → `zh-Hans`, zh-Hant → `zh-Hant` |

## Rules for every catalogue

- Every English key is present, with the same `{placeholders}` and the same keyboard glyphs.
  `tests/ui/locales.test.mjs` checks it, along with each language's plural categories
  (`Intl.PluralRules`), `dir`, `widths` and `dateLetters`.
- Product names and identifiers stay as they are: Test Bench, OpenAPI, JSON, cURL, HTTP
  methods, header names, operationIds, `$ref`, `components.schemas`.
- `widths` are measured: each language's Send and Preview label with its keycaps, at the widest
  density, rounded up to 0.25em with 0.25em of air, so the buttons never move. Never copy them from
  another language or estimate them. With the demo running, `node tools/measure-widths.mjs` reports
  the measured widths for all 29 catalogues, `--write` rewrites each catalogue's `widths` line
  (English, the approved baseline, is only checked) and `--check` fails when a button is narrower
  than its label. `tools/browser-test.mjs` asserts that every catalogue's widths hold its label.
  The confirmation's Cancel and Confirm send are not fixed-width: they share the pair's room and grow.

## Review status

<!-- machine-translated: needs native review -->

These catalogues were machine-translated and haven't been reviewed by a native speaker yet. The
language picker tags them "Preview" (`review: true` in `LANGUAGES`); remove the flag once a
native speaker has reviewed a catalogue.

`fr`, `es`, `it`, `nl`, `pt-BR`, `pt-PT`, `da`, `nb`, `fi`, `sv`, `cs`, `el`, `pl`, `ru`, `tr`,
`uk`, `fa`, `he`, `hi`, `id`, `ja`, `ko`, `th`, `vi`, `zh-Hans`, `zh-Hant`

The v5 strings added to `de` and `ar` (keys under `attr.`, `field.`, `select.`, `lookup.`,
`dep.`, `match.`, `lang.`, `resp.raw.`, `resp.table.` and `resp.legend.`) are machine-translated
too and need the same review.
