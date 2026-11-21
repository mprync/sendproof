// Measures the fixed Send and Preview button widths for every UI catalogue, in the real app.
//
//   node tools/measure-widths.mjs            print the measured widths and compare them with the files
//   node tools/measure-widths.mjs --write    rewrite each catalogue's `widths` line
//   node tools/measure-widths.mjs --check    exit 1 when a catalogue's width is narrower than its content
//
// How: the script opens the running app, then asks the app's own modules (i18n, action-bar,
// shortcuts) for each catalogue's buttons on each platform. It lets every button take its natural
// width at each density, reads the width in `em` of the button's own font size and keeps the widest.
// Each width is the widest natural width of that button (Send also at read-only, with its own
// keycap) rounded up to 0.25em, plus 0.25em of air, which is the rule in ui/locales/README.md.
// The confirmation's Cancel and Confirm send are not fixed-width: ui/styles.css sizes that pair
// to its content, at least as wide as Send + Preview. English is the approved baseline: it is
// checked, never rewritten. Because em follows the button's font size, one measurement holds at every
// text size and density; rem padding is included at each density's real ratio.
//
// Env: BASE=<url> the running Treasury example (default http://127.0.0.1:5189).
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const base = (process.env.BASE || 'http://127.0.0.1:5189').replace(/\/$/, '').replace(/\/bench$/, '');
const write = process.argv.includes('--write');
const check = process.argv.includes('--check');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(`${base}/bench/`);
await page.waitForSelector('.topbar');

/** Natural widths in em, per catalogue and platform, at the widest density. */
const measured = await page.evaluate(async () => {
  const { LANGUAGES, CATALOGUES, configure, loadLanguage } = await import('/bench/i18n.js');
  const { updateSettings } = await import('/bench/settings.js');
  const { runButtons } = await import('/bench/action-bar.js');
  const result = {};
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset-block-start:0;inset-inline-start:0;display:flex;flex-direction:column;align-items:flex-start;visibility:hidden';
  document.body.append(host);
  // Script fonts arrive after the first layout, so read until the fonts are loaded and the widths
  // stop changing between two reads.
  const natural = async html => {
    const read = () => {
      host.innerHTML = html;
      return Object.fromEntries([...host.querySelectorAll('.btn-run')].map(button => {
        button.style.inlineSize = 'auto';
        return [button.dataset.action, button.getBoundingClientRect().width / parseFloat(getComputedStyle(button).fontSize)];
      }));
    };
    let last = read();
    for (let attempt = 0; attempt < 60; attempt++) {
      await document.fonts.ready;
      await new Promise(resolve => setTimeout(resolve, 100));
      const now = read();
      const steady = Object.keys(now).every(key => Math.abs(now[key] - last[key]) < 0.001);
      last = now;
      if (steady && document.fonts.status === 'loaded' && attempt >= 2) return now;
    }
    throw new Error('Fonts did not settle');
  };
  for (const id of CATALOGUES) {
    const language = LANGUAGES.find(item => item.catalogue === id).id;
    await loadLanguage(language);
    result[id] = {};
    for (const platform of ['mac', 'win']) {
      const need = { send: 0, preview: 0 };
      for (const density of ['compact', 'default', 'comfortable']) {
        // updateSettings loads the catalogue, the script font and the density as the app does;
        // the platform is then forced, because the browser is on one platform only.
        updateSettings({ language, density });
        configure({ language, platform });
        const post = await natural(runButtons({ method: 'POST' }, true));
        const get = await natural(runButtons({ method: 'GET' }, true));
        need.send = Math.max(need.send, post.send, get.send);
        need.preview = Math.max(need.preview, post.preview);
      }
      result[id][platform] = need;
    }
  }
  host.remove();
  return result;
});
await browser.close();

const up = em => Math.ceil(em / 0.25 - 1e-9) * 0.25;
const round = em => up(em) + 0.25;
const slots = need => ({ send: round(need.send), preview: round(need.preview) });
const format = value => `${String(Number(value.toFixed(2)))}em`;
const line = widths => `widths: { mac: { preview: '${format(widths.mac.preview)}', send: '${format(widths.mac.send)}' }, win: { preview: '${format(widths.win.preview)}', send: '${format(widths.win.send)}' } },`;

let short = 0;
for (const [id, platforms] of Object.entries(measured)) {
  const widths = Object.fromEntries(Object.entries(platforms).map(([platform, need]) => [platform, slots(need)]));
  const file = join(root, 'ui', 'locales', `${id}.js`);
  const source = await readFile(file, 'utf8');
  const existing = /widths: \{ mac: \{ preview: '([\d.]+)em', send: '([\d.]+)em' \}, win: \{ preview: '([\d.]+)em', send: '([\d.]+)em' \} \},/.exec(source);
  if (!existing) throw new Error(`${id}.js has no widths line`);
  const current = { mac: { preview: +existing[1], send: +existing[2] }, win: { preview: +existing[3], send: +existing[4] } };
  const clipped = ['mac', 'win'].flatMap(platform => {
    const need = platforms[platform];
    const short = [];
    if (current[platform].send < need.send + 0.25 - 1e-9) short.push('send');
    if (current[platform].preview < need.preview + 0.25 - 1e-9) short.push('preview');
    return short.map(slot => `${platform}.${slot}`);
  });
  // English is the approved baseline: it is only ever checked, never rewritten.
  const same = line(widths) === existing[0] || (id === 'en' && !clipped.length);
  console.log(`${id.padEnd(8)} ${same ? 'ok     ' : 'differs'} ${line(widths)}${clipped.length ? `   too narrow now: ${clipped.join(', ')}` : ''}`);
  if (clipped.length) short++;
  if (write && !same) await writeFile(file, source.replace(existing[0], line(widths)));
}
if (check && short) {
  console.error(`${short} catalogue(s) have a button narrower than its content. Run node tools/measure-widths.mjs --write.`);
  process.exit(1);
}
