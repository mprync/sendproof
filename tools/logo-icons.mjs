// Renders the Sendproof app icons and the favicon fallback from the Dry Run mark, with Playwright:
//
//   node tools/logo-icons.mjs
//
// The mark is monochrome (never blue). The icons are light on dark: the white darts, the faint one
// at 0.4, on a #181a20 tile with rounded corners, so they read on light and dark surfaces alike
// (a dock, a browser tab, a GitHub avatar). Writes docs/images/logo/sendproof-icon-<size>.png for
// 16, 32, 64, 128, 256 and 512, and ui/favicon.png (32 px), the fallback for browsers that don't
// take ui/favicon.svg. Regenerate the Go embedded UI afterwards (see adapters/go).
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '..');
const sizes = [16, 32, 64, 128, 256, 512];
const tile = '#181a20';
const ink = '#f7f7f8';

// The mark on its 24 x 24 grid (docs/images/logo/sendproof-mark.svg): the faint preview dart and the solid one.
const mark = `<path d="M1.5 5 L7.57 8.15 L9.11 12 L7.57 15.85 L1.5 19 L4.3 12 Z" opacity=".4"/><path d="M9 5 L22.5 12 L9 19 L11.8 12 Z"/>`;

// The darts fill 70% of the tile, centred; the corners are 22% of the side, the usual app-icon curve.
const icon = size => `<!doctype html><html><body style="margin:0;background:transparent">
  <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" style="display:block">
    <rect width="24" height="24" rx="5.28" fill="${tile}"/>
    <g transform="translate(12 12) scale(0.7) translate(-12 -12)" fill="${ink}" stroke="${ink}" stroke-width="1" stroke-linejoin="round">${mark}</g>
  </svg></body></html>`;

function optimise(file) {
  try { execFileSync('oxipng', ['-o', '4', '--strip', 'safe', '-q', file]); } catch { /* oxipng is optional */ }
}

const browser = await chromium.launch();
try {
  const outputs = [...sizes.map(size => [size, join(root, `docs/images/logo/sendproof-icon-${size}.png`)]), [32, join(root, 'ui/favicon.png')]];
  for (const [size, out] of outputs) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(icon(size));
    await page.locator('svg').screenshot({ path: out, omitBackground: true });
    await page.close();
    optimise(out);
    console.log(out.replace(`${root}/`, ''));
  }
} finally {
  await browser.close();
}
