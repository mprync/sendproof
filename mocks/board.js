// State boards (?set=before-run | zero | copy). Each frame is built by the same functions
// that render the workbench (TB.buildResult, TB.buildSidebar, TB.buildRequest, TB.copyBtn),
// so a board can never drift from the screens it summarises.
(function () {
  const { ico, kbd, copyBtn, copyTextBtn, t } = window.TB;
  const params = s => Object.fromEntries(new URLSearchParams(s));
  const result = s => window.TB.buildResult(params(s));
  const sidebar = s => window.TB.buildSidebar(params(s));
  const request = s => window.TB.buildRequest(params(s));

  // Copy feedback: the same control idle and copied, side by side, so any shift would show.
  const urlbar = st => `<div class="urlbar" style="margin:0"><span class="method m-post">POST</span><span class="url"><span class="base">http://127.0.0.1:5189</span>/api/v2/orders</span>${copyBtn(t('pick.copy'), { state: st, size: 'btn-xs' })}</div>`;
  const bodyBar = st => `<div class="viewer"><div class="viewer-bar"><div class="segmented"><button aria-pressed="true">Pretty</button><button aria-pressed="false">Raw</button><button aria-pressed="false">Schema</button></div><span class="spacer"></span><button class="btn btn-ghost btn-icon btn-sm" aria-label="Search body">${ico('search', 'i i-sm')}</button>${copyBtn('Copy body', { state: st })}</div><div class="code-view ltr"><div class="ln"><span class="no">1</span><span></span><span class="src" style="--d:0"><span class="tok-p">{</span></span></div><div class="ln"><span class="no">2</span><span></span><span class="src" style="--d:1"><span class="tok-k">"id"</span><span class="tok-p">: </span><span class="tok-s">"7d2e41a0-5c1b-…"</span></span></div></div></div>`;
  const sqlBar = st => `<div class="sql-wrap"><div class="sql-bar">SQL with parameter values · 6.2 ms · 1 row<span class="spacer"></span>${copyBtn('Copy SQL with values', { state: st, size: 'btn-xs' })}</div><pre class="sql"><span class="tok-k">INSERT INTO</span> Orders (Id, Status, Amount) <span class="tok-k">VALUES</span> (…)</pre></div>`;
  const hdrBar = st => `<div class="section-label" style="margin:0">Response headers <span class="schema">9</span><span class="rule" aria-hidden="true"></span>${copyTextBtn('Copy all', { state: st, cls: 'btn-xs btn-ghost' })}</div>`;
  const failed = `<div class="viewer"><div class="viewer-bar"><span class="faint" style="font-size:var(--fs-sm);padding-inline-start:0.35rem">Response body</span><span class="spacer"></span>${copyBtn('Copy body')}</div>
    <div class="inline-note danger flush" role="alert">${ico('alert', 'i i-sm')}<span><strong>Couldn’t copy.</strong> Clipboard access was blocked. The body is selected: press ${kbd('mod', 'C')}.</span><button class="btn btn-ghost btn-icon btn-xs" aria-label="Dismiss">${ico('x', 'i i-sm')}</button></div>
    <div class="code-view ltr is-selected"><div class="ln"><span class="no">1</span><span></span><span class="src" style="--d:0">{ "id": "7d2e41a0-5c1b-…", "status": "Draft" }</span></div></div></div>`;
  const copyPair = (cap, idle, copied, note) => [
    [`${cap} · idle`, '', `<div class="copy-demo">${idle}</div>`],
    [`${cap} · copied`, note, `<div class="copy-demo">${copied}</div>`],
  ];

  const sets = {
    'before-run': {
      title: 'Result tabs before a run',
      lede: 'All five tabs are present and clickable before anything runs. Each says what will appear there and how to get it. Counts show “–” until they’re known.',
      cols: 2, height: 560,
      frames: [
        ['Response', 'Steps and documented responses', result('state=blank&rtab=response')],
        ['Database', 'What Preview captures', result('state=blank&rtab=database')],
        ['Side effects', 'Held by Preview, run by Send', result('state=blank&rtab=effects')],
        ['Logs', 'Request-scoped, with SQL', result('state=blank&rtab=logs')],
        ['Headers', 'Response, and request as sent', result('state=blank&rtab=headers')],
        ['Read-only GET', 'No Preview step for safe methods', result('op=list&rtab=database')],
      ],
    },
    zero: {
      title: 'Zero items, no matches and nothing captured',
      lede: 'One anatomy everywhere: an icon, a title that states the fact, one or two sentences on why, and the next action with its shortcut.',
      cols: 2, height: 450,
      frames: [
        ['Database · 401', 'Rejected before the handler', result('auth=out&op=list&run=401&rtab=database')],
        ['Side effects · none', 'Ran, triggered nothing', result('state=filled&run=preview&rtab=effects&effects=zero')],
        ['Logs · filtered out', 'Names the filters', result('state=filled&run=preview&rtab=logs&logs=empty')],
        ['Database · Send', 'Not captured, and why', result('state=filled&run=send&rtab=database')],
        ['Filter · no match', 'Suggests a spelling', sidebar('filter=nomatch')],
        ['Operations · none', 'Spec has no paths', sidebar('filter=empty')],
        ['Models · none', 'No components.schemas', sidebar('side=models&filter=empty')],
        ['Headers · no custom', 'Managed ones still listed', request('tab=headers&hstate=empty&state=filled'), 'kv'],
      ],
    },
    copy: {
      title: 'Copy feedback',
      lede: 'The icon becomes a check and a “Copied” bubble overlays the button for 1.5 s, announced politely (“URL copied”), then eases back. Nothing moves: compare each pair. If the clipboard is blocked, an inline notice selects the text instead; the pane is never replaced.',
      cols: 2, height: 140,
      frames: [
        ...copyPair('URL bar', urlbar('idle'), urlbar('copied'), 'announces “URL copied”'),
        ...copyPair('Response body', bodyBar('idle'), bodyBar('copied'), 'announces “Body copied”').map(f => [...f, '', 190]),
        ...copyPair('SQL in Logs', sqlBar('idle'), sqlBar('copied'), 'announces “SQL copied”'),
        ...copyPair('Response headers', hdrBar('idle'), hdrBar('copied'), 'label swaps in a fixed width'),
        ['Clipboard blocked', 'inline, text selected, pane untouched', `<div class="copy-demo" style="padding-block-start:1rem">${failed}</div>`, '', 210],
        ['Timing', '', `<div class="copy-demo" style="padding-block-start:1.25rem"><div class="timeline">
            <span class="tick">${ico('copy', 'i i-sm')}Click or ${kbd('shift', 'mod', 'U')}</span>${ico('arrow-right', 'i i-sm')}
            <span class="tick" style="color:var(--ok)">${ico('check', 'i i-sm')}Check + “Copied” for 1.5 s</span>${ico('arrow-right', 'i i-sm')}
            <span class="tick">Fades back over 200 ms</span></div>
            <p class="faint" style="margin:0;font-size:var(--fs-sm)">Reduced motion: no fade, the icon swaps back instantly. Screen readers hear one polite announcement.</p></div>`, '', 210],
      ],
    },
  };

  const set = sets[window.TB.q.set || 'before-run'];
  document.getElementById('board').outerHTML = `
    <main class="board" aria-labelledby="board-title">
      <div class="board-head"><h1 id="board-title">${set.title}</h1><p>${set.lede}</p></div>
      <div class="board-grid" style="--cols:${set.cols}">
        ${set.frames.map(([cap, detail, html, scroll, h]) => `
        <figure class="frame" style="margin:0">
          <figcaption class="frame-cap"><strong>${cap}</strong>${detail ? `<span>· ${detail}</span>` : ''}</figcaption>
          <div class="frame-body" style="block-size:${h || set.height}px" ${scroll ? `data-scroll="${scroll}"` : ''}>${html}</div>
        </figure>`).join('')}
      </div>
    </main>`;
  // Bring the interesting part of a tall pane into view (mock-only).
  document.querySelectorAll('[data-scroll="kv"]').forEach(f => {
    const sc = f.querySelector('.pane-scroll'), el = f.querySelector('.kv-toolbar');
    if (sc && el) sc.scrollTop = el.offsetTop - 12;
  });
})();
