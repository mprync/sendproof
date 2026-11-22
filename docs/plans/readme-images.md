# README images: pending requests

**Status (2026-11-22): 1 to 5 done, rendered and waiting for the owner's review (6).** The images are
captured from a second store-example instance at `http://localhost:5080` (the README's `dotnet run`
port), so the address pill and request URLs match the README. The interface has 29 catalogues, not 30,
so the strips and the README say "29 languages". The owner picked the Dry Run mark, monochrome.

The README images and the social preview are rendered by `node tools/readme-shots.mjs` from the running store example (`examples/StoreApi`, http://127.0.0.1:5189/sendproof/) into the frames in `docs/images/src/`. Before the first render and push, these owner requests must be in:

1. **Nothing that names a real employer's domain, anywhere.** The demo is the generic "Acme Store API"; check every rendered image by eye.
2. **Show the whole feature set.** Hero: a Preview of placing an order with changes grouped by store (SQL rows, MongoDB document diff, Redis/DynamoDB). Feature shots: the Logs tab with a long SQL/MongoDB/Redis/DynamoDB command chain, the Docs view, the response viewer with schema match, Preview unavailable / blocked by the write guard, and a phone or RTL shot.
3. **The hero and the social card show the supported languages.** Add a "works with" strip to `hero.html` and `social.html`: one chip per language (C#/.NET, TypeScript/Node, Python, Java, Kotlin, Go, Ruby, PHP, Rust) with its mark from `ui/lang-icons.js` (CC0 Simple Icons and the geometric C#/Java marks) and its name, styled like the frame (chips on the gradient, both themes), plus a quieter line naming the main frameworks. Also show the spoken languages the workbench is translated into (30 locales, including right-to-left): a second strip of language names written in their own script (English, Deutsch, Français, Español, Português, 日本語, 简体中文, 한국어, العربية, עברית, हिन्दी, Ελληνικά, Русский, Türkçe, … "+16 more", with a small RTL marker), no flags, since flags name countries, not languages. Take the list from `ui/locales/`. The phone shot can show the Arabic RTL layout next to it. The README gets the same as a line or table ("Available in 30 languages") linking to the locale list.
4. **New logo.** Replace the current header mark (it reads as a dust bin) once the owner picks a concept from `docs/images/logo-concepts/board.png`, everywhere it appears: the workbench header and favicon (`ui/`, regenerate the Go embedded copy), the mocks, the frames and the social card.
5. Update the README's run command and the hero's "Place order" label to the store example's final names, and set `SHOT_BLOCKED` to an operation whose Preview the write guard stops.
6. After rendering, show every image to the owner before pushing; then the owner uploads `docs/images/social-preview.png` under Settings → General → Social preview.
