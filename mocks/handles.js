// Pane dividers, added after every pane is rendered (carried over from v2). They are focusable
// separators; ?resizing=1 shows the size tip while the sidebar divider is dragged.
// v6 (?v6=1): the data-store layer loads here, after every pane is built. It's written in only
// with v6, so the v3, v4 and v5 screens load exactly the scripts they always did.
if (/[?&]v6=/.test(location.search)) document.write('<script src="v6-icons.js"><\/script><script src="v6-stores.js"><\/script>');
// v7 (?v7=1, on top of v6): journeys. Written in the same way, so nothing changes without it.
if (/[?&]v7=/.test(location.search)) document.write('<script src="v7-journeys.js"><\/script>');
(function () {
  const ws = document.querySelector('.workspace');
  if (!ws || innerWidth <= 896) return;
  const panes = ws.querySelectorAll(':scope > .sidebar, :scope > .pane');
  const rtl = document.documentElement.dir === 'rtl';
  const add = (after, label) => {
    if (!after) return null;
    const h = document.createElement('div');
    h.className = 'resize-handle';
    h.setAttribute('role', 'separator');
    h.setAttribute('aria-orientation', 'vertical');
    h.setAttribute('aria-label', label);
    h.tabIndex = 0;
    ws.appendChild(h);
    const r = after.getBoundingClientRect(), w = ws.getBoundingClientRect();
    h.style.insetInlineStart = (rtl ? w.right - r.left : r.right - w.left) + 'px';
    return h;
  };
  const left = add(panes[0], 'Resize operations sidebar');
  if (panes.length > 2) add(panes[1], 'Resize request and result panes');
  if (left && window.TB.q.resizing) {
    left.classList.add('is-active');
    left.innerHTML = `<span class="size-tip">${Math.round(panes[0].getBoundingClientRect().width)} px · double-click to reset</span>`;
  }
})();
