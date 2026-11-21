// Pane dividers, added after every pane is rendered (carried over from v2). They are focusable
// separators; ?resizing=1 shows the size tip while the sidebar divider is dragged.
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
