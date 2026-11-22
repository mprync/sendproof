// v7 board (journeys.html?v6=1&v7=1&set=findings), built with the screens' own builders:
// every comparison finding at the result pane's width, the step verdicts, and the rail's states.
(function () {
  const { q, ico } = window.TB;
  const root = document.getElementById('board');
  if (!root || !q.v7 || !window.SP7) return;
  document.body.classList.add('board6');
  const { cmpCard, shipCard, missCard, adCard, fTag, matched, railList, v, ltr, opBadge, fromStep } = window.SP7;
  const logo = window.SP.logo;

  const extra = (approved) => cmpCard({
    kind: approved ? 'approved' : 'extra', store: 'sqlite', op: 'insert', t: 'AuditEvents', key: ['Id', '9f04…7c1e'], foot: !approved,
    body: `<div class="cf7-miss is-rev"><div class="is-none"><span class="cf7-lbl">Expected</span><p><strong>Nothing listed</strong></p><p>The step lists no write to <code dir="ltr">AuditEvents</code>.</p></div>
      <div><span class="cf7-lbl">Written</span><p><code dir="ltr">Action</code> ${v('order.created')}</p><p><code dir="ltr">OrderId</code> ${v('5e3a91c0…c2d1')}</p><p><code dir="ltr">Actor</code> ${v('ada.admin@acme.dev')}</p></div></div>
      ${approved ? `<p class="cf7-cover">${ico('badge-check', 'i i-sm')}<span>Allowed by <a href="#" class="adc7">${ico('badge-check', 'i i-sm')}${ltr('AD-0007')}</a>: Create order writes an AuditEvents row since 2.1.</span></p>` : ''}`,
  });
  const unchecked = cmpCard({
    kind: 'unchecked', store: 'mongodb', op: 'insert', t: 'order_events', foot: false,
    body: `<div class="cf7-skip"><p><strong>Not checked.</strong> This step was sent without a trace, so Sendproof has no record of what it wrote. Arazzo’s <code dir="ltr">successCriteria</code> were still checked.</p><p class="faint">Turn on traced Send to compare writes in a Send run.</p></div>`,
  });
  const expired = `<article class="ad7 is-expired"><header class="ad7-head"><span class="adc7">${ico('badge-check', 'i i-sm')}${ltr('AD-0004')}</span><span class="ad7-what">${ltr('<code>Payments.ProviderReference</code>')} · ${v('pi_…')} → ${v('ch_…')}</span><span class="spacer"></span><span class="ad7-step">Step 3</span></header>
    <p class="ad7-reason" lang="en">The payment sandbox briefly returned charge IDs instead of intent IDs.</p>
    <p class="ad7-meta">Approved by Ada Admin · 28 Oct 2026<span class="sep">·</span><span class="is-exp">${ico('clock', 'i i-sm')}Expired 30 Nov 2026 · covers nothing</span></p>
    <p class="ad7-unused">${ico('info', 'i i-sm')}<span>The difference it allowed now fails the step. Renew the record, or fix the expectation.</span></p></article>`;
  const vd = (tone, icon, title, body) => `<div class="vd7 is-${tone}"><span class="vd7-ico">${ico(icon)}</span><div class="vd7-text"><h3>${title}</h3><p>${body}</p></div></div>`;
  const cap = (strong, text) => `<p class="bd6-cap"><strong>${strong}</strong> · ${text}</p>`;
  const side = (run, label) => `<div class="bd7-rail"><p class="bd6-cap"><strong>${label}</strong></p><nav class="sidebar j7-side"><div class="nav"><ul><li><a class="nav-item jn7 is-here has-rail" aria-current="page" href="#"><span class="jn7-n">5</span><span class="label-text" lang="en">Order to shipment</span></a>${railList(run)}</li></ul></div></nav></div>`;

  root.innerHTML = `<div class="bd6 bd7">
    <header class="bd6-h"><h1>Comparing a step with its expected writes</h1>
      <p>After each step, Sendproof matches every expected write in <code>store.expect.json</code> to a captured change by store, table or collection, operation and key, then compares field by field. Each expected write, effect and unlisted change gets one finding. A difference passes only when an approved-difference record covers it; the record's ID is shown wherever it was used.</p></header>
    <section class="bd6-sec"><h2>Findings<span>At the result pane's width. Red fails the step, blue is covered by a record, green matched</span></h2>
      <div class="bd6-grid" style="grid-template-columns:repeat(2, 34.5rem)">
        <div class="bd6-col">
          <div class="bd6-cell">${cap('Differs', 'written, but a field has another value; an approved field inside the same row stays blue')}${shipCard()}</div>
          <div class="bd6-cell">${cap('Missing', 'expected, but nothing like it was written')}${missCard()}</div>
          <div class="bd6-cell">${cap('Match', 'one quiet line each, under the problems')}${matched()}</div>
        </div>
        <div class="bd6-col">
          <div class="bd6-cell">${cap('Extra', 'written, but the step lists nothing for that table (unlisted: fail)')}${extra(false)}</div>
          <div class="bd6-cell">${cap('Approved', 'the same extra row, covered by AD-0007')}${extra(true)}</div>
          <div class="bd6-cell">${cap('Not checked', 'no capture to compare: Send without a trace, an unhooked store, capture truncated')}${unchecked}</div>
          <div class="bd6-cell">${cap('Expired record', 'an approved difference past its date covers nothing, and the run says so')}${expired}</div>
        </div>
      </div></section>
    <section class="bd6-sec"><h2>Step verdicts<span>The banner at the top of the Expected tab</span></h2>
      <div class="bd6-grid" style="grid-template-columns:repeat(2, 34.5rem)">
        ${vd('pass', 'circle-check', 'Step 3 passed', 'Three writes match, and the payment receipt was held as expected.')}
        ${vd('ad', 'badge-check', 'Step 1 passed with 1 approved difference', 'An AuditEvents row the step doesn’t list was allowed by AD-0007.')}
        ${vd('fail', 'circle-x', 'Step 4 failed', 'The shipment was written with the wrong service level, and the stock reservation wasn’t deleted.')}
        ${vd('fail', 'ban', 'Step 3 was refused', 'The journey expects 200. The API answered 409 payment_not_authorized, so steps 4 and 5 didn’t run.')}
        ${vd('warn', 'flask-off', 'Preview blocked at step 2', 'Price cart writes to Redis, which can’t roll back. Nothing was written; start a Send run to go past this step.')}
        ${vd('ok2', 'circle-check', 'Step 2 refused, as expected', 'Ship an unpaid order expects 409 order_not_paid and no writes. Both held.')}
      </div></section>
    <section class="bd6-sec"><h2>The progress rail<span>The open journey's steps in the sidebar, in every state</span></h2>
      <div class="bd7-rails">
        ${side([['done', '201 · 64 ms', 'ad'], ['done', '200 · 18 ms'], ['done', '200 · 71 ms'], ['current', ''], ['pending', '']], 'Preview run, at step 4')}
        ${side([['done', '201 · 64 ms', 'ad'], ['done', '200 · 18 ms'], ['done', '200 · 71 ms'], ['fail', '201 · 58 ms'], ['done', '200 · 14 ms']], 'Finished, step 4 failed')}
        ${side([['done', '201 · 88 ms'], ['done', '200 · 21 ms'], ['refused', '409 · 34 ms'], ['skipped', ''], ['skipped', '']], 'Send run, stopped at step 3')}
      </div></section>
  </div>`;
})();
