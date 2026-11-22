// Shared by the README frames. Picks the theme from ?theme=light|dark, then points every crop at
// its capture in artifacts/readme/raw and sizes it from the regions measured at capture time
// (manifest.js, written by tools/readme-shots.mjs).
//
//   <div class="crop" data-raw="order-database" data-region="work" data-width="1150" data-height="800">
//     <img alt="">
//   </div>
//
// data-region is `full`, `work`, `result`, `body`, `content` or `documents` (see regions() in the
// script); data-width is the displayed width in CSS pixels;
// data-height (optional) trims the bottom; data-top (optional) trims the top, in capture pixels;
// data-theme (optional) fixes the capture's theme; data-optional removes the enclosing
// [data-optional-group] when the capture does not exist (a shot the app could not provide).
const theme = new URLSearchParams(location.search).get('theme') === 'dark' ? 'dark' : 'light';
document.documentElement.classList.toggle('dark', theme === 'dark');
document.addEventListener('DOMContentLoaded', () => {
  // The address pill names the host the captures came from (localhost:5080 for `dotnet run`).
  if (window.SHOTS_HOST) document.querySelectorAll('.window .url b').forEach(host => { host.textContent = window.SHOTS_HOST; });
  for (const crop of document.querySelectorAll('.crop[data-raw]')) {
    const name = `${crop.dataset.raw}-${crop.dataset.theme ?? theme}`;
    const shot = window.SHOTS?.[name];
    const region = shot?.regions[crop.dataset.region ?? 'full'];
    if (!region && crop.dataset.optional !== undefined) { crop.closest('[data-optional-group]')?.remove(); continue; }
    if (!region) throw new Error(`No capture or region for ${name}; run node tools/readme-shots.mjs`);
    const top = Number(crop.dataset.top ?? 0);
    const scale = Number(crop.dataset.width ?? region.w) / region.w;
    const height = crop.dataset.height ? Number(crop.dataset.height) / scale : region.h - top;
    Object.entries({ '--vw': shot.vw, '--x': region.x, '--y': region.y + top, '--w': region.w, '--h': Math.min(height, region.h - top), '--s': scale })
      .forEach(([property, value]) => crop.style.setProperty(property, value));
    crop.querySelector('img').src = `../../../artifacts/readme/raw/${name}.png`;
  }
});
