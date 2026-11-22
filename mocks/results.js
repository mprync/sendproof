// Result pane for the v3 mocks. All five tabs are always present and always clickable.
// Each tab shows its content, a zero state, or an explanation of why nothing was captured.
//   run   none | running | preview | send | 401 | neterror
//   rtab  response | database | effects | logs | headers
//   rview pretty | schema      logs=empty      copied=body|sql|headers|bodyfailed
//   v4: the body is the real seeded response from mocks/spec.js, every object open.
//   body=large shows a 100-item list (auto-collapsed, with a note)   json=collapsed (Collapse all)
(function () {
  const { ico, kbd, aks, tab, copyBtn, copyTextBtn, state, t } = window.TB;
  const { num, unit } = window.i18n;
  // Captured data (rows, JSON, headers) stays invariant, exactly as stored or sent.
  // Only Sendproof's own prose, counts and metrics follow the locale.
  const metrics = (ms, kb) => `<span class="metric"><bdi>${unit(ms, 'millisecond')}</bdi> · <bdi>${unit(kb, 'kilobyte', 1)}</bdi></span>`;
  /** Builds the pane for a set of URL-style parameters; the boards call it directly. */
  function build(q) {
  const op = q.op || 'create';
  const run = q.run || (q.state === 'running' ? 'running' : 'none');
  // Traced Send is on by default in Development (owner decision); traced=off shows plain Send.
  const traced = run === 'send' && q.traced !== 'off';
  const rtab = q.rtab || 'response';
  const readOnly = op === 'get' || op === 'list';
  const btnPreview = `<button class="btn btn-primary btn-sm">${ico('flask', 'i i-sm')}${t('preview')} ${kbd('mod', 'enter')}</button>`;
  const btnSend = `<button class="btn btn-sm">${ico('send', 'i i-sm')}${t('send')} ${kbd(...(readOnly ? ['mod', 'enter'] : ['shift', 'mod', 'enter']))}</button>`;
  const ghost = labels => `<div class="ghost" aria-hidden="true">${labels.map(([icon, w1, w2]) => `<div class="ghost-row">${ico(icon, 'i i-sm')}<span class="bar" style="inline-size:${w1}"></span><span class="spacer"></span><span class="bar" style="inline-size:${w2}"></span></div>`).join('')}</div>`;

  /* ---------- Counts per run: number, 0, or '–' when not captured ---------- */
  const counts = {
    none: [undefined, '–', '–', '–', '–'],
    running: [undefined, '–', '–', '–', '–'],
    preview: [undefined, 3, 4, 11, 9],
    // A GET writes nothing, so a traced read shows zero changes and zero effects.
    send: readOnly ? (traced ? [undefined, 0, 0, 2, 8] : [undefined, '–', '–', 2, 8]) : traced ? [undefined, 3, 4, 11, 9] : [undefined, '–', '–', 11, 9],
    401: [undefined, 0, 0, 3, 3],
    neterror: [undefined, '–', '–', '–', '–'],
  }[run];

  /* ---------- Response ---------- */
  function response() {
    if (run === 'none') return state({
      icon: 'braces', title: 'The response will appear here',
      body: readOnly ? 'Run the request to see the status, body and timing. GET is read-only, so Send changes nothing.'
        : 'Run the request to see the status, body and timing. Preview runs it for real, then rolls the database back. Send commits.',
      extra: `<ol class="steps">
        <li>${ico('wand', 'i i-sm')}Fill required fields${kbd('shift', 'mod', 'F')}</li>
        ${readOnly ? '' : `<li>${ico('flask', 'i i-sm')}Preview, then roll back${kbd('mod', 'enter')}</li>`}
        <li>${ico('send', 'i i-sm')}${readOnly ? 'Send (read-only)' : 'Send and commit'}${kbd(...(readOnly ? ['mod', 'enter'] : ['shift', 'mod', 'enter']))}</li>
      </ol>
      <div class="expect"><div class="expect-h">Documented responses</div>
        ${(readOnly ? [['200', 'ok', 'OK', 'Order[]'], ['401', 'err', 'Not signed in', ''], ['403', 'err', 'Missing support role', 'ProblemDetails']]
          : [['201', 'ok', 'Created', 'Order'], ['400', 'err', 'Validation failed', 'ValidationProblemDetails'], ['401', 'err', 'Not signed in', ''], ['403', 'err', 'Missing support role', 'ProblemDetails'], ['409', 'err', 'Idempotency key reused', 'ProblemDetails']])
          .map(([c, cls, d, s]) => `<div class="expect-row"><span class="code ${cls}">${c}</span><span lang="en">${d}</span><span class="spacer"></span>${s ? `<a class="type-link" href="#">${s}</a>` : '<span class="faint">no body</span>'}</div>`).join('')}
      </div>`,
    });
    if (run === '401') return `
      <div class="problem" role="alert">
        <div class="problem-head">${ico('lock')}<div><h3>You’re not signed in</h3><p>The API needs a signed-in user for <span lang="en">List orders</span> (<code>cookieAuth</code>), so it answered 401 before running any code. Nothing was read or changed.</p></div></div>
        <div class="actions"><button class="btn btn-primary">${ico('log-in', 'i i-sm')}Sign in and retry ${kbd('shift', 'mod', 'U')}</button><button class="btn">Use a seeded account${ico('chevron-down', 'i i-sm')}</button></div>
        <dl class="facts problem-facts"><dt>Body</dt><dd class="plain">Empty · 0 B</dd><dt>WWW-Authenticate</dt><dd>Cookie realm="StoreApi"</dd><dt>Retry</dt><dd class="plain">Runs <span lang="en">List orders</span> again with the same inputs once you’re signed in</dd></dl>
      </div>`;
    if (run === 'neterror') return state({
      icon: 'wifi-off', tone: 'danger', title: 'Couldn’t reach the API',
      body: 'Nothing came back from <code>http://127.0.0.1:5189</code>. The request may not have reached the server, so nothing was saved.',
      why: 'Is the API running? Start it with <code>dotnet run</code> in <code>examples/StoreApi</code>, then try again.',
      actions: [`<button class="btn btn-primary btn-sm">${ico('refresh', 'i i-sm')}Try again ${kbd('mod', 'enter')}</button>`, `<button class="btn btn-ghost btn-sm">Copy error details</button>`],
    });
    const schemaView = q.rview === 'schema';
    // The real seeded response for this operation (mocks/spec.js); ?body=large shows a big list.
    const samples = window.TB_SAMPLES || {};
    const value = q.body === 'large' ? samples.ordersLarge : op === 'list' ? samples.ordersPage : samples.order;
    const json = { ...window.TB.schema.jsonView(value ?? {}, { label: 'Response body, application/json', collapseAll: q.json === 'collapsed' }), bytes: JSON.stringify(value ?? {}).length };
    const bodyFailed = q.copied === 'bodyfailed';
    return `
      ${op === 'list' ? '' : `      <div class="next-steps" role="group" aria-label="Use this result">
        <span class="faint">Use <code>id</code> in</span>
        <button class="chain"><span class="method m-get">GET</span><span lang="en">Get order</span>${kbd('mod', 'G')}</button>
        <button class="chain"><span class="method m-post">POST</span><span lang="en">Ship order</span>${ico('shield', 'i i-sm faint')}</button>
      </div>`}
      <div class="viewer">
        <div class="viewer-bar">
          <div class="segmented" role="group" aria-label="Body view"><button aria-pressed="${!schemaView}">Pretty</button><button aria-pressed="false">Raw</button><button aria-pressed="${schemaView}">Schema</button></div>
          <span class="pill pill-ok">${ico('check', 'i i-sm')}Matches <a class="type-link" href="#">${op === 'list' ? 'PagedListOfOrder' : 'Order'}</a></span>
          <span class="spacer"></span>
          ${schemaView ? '' : `<button class="btn btn-ghost btn-xs" aria-keyshortcuts="Alt+Shift+ArrowDown">${ico('chevrons-ud', 'i i-sm')}${json.large || q.json === 'collapsed' ? t('expandAll') : t('collapseAll')}</button>`}
          <button class="btn btn-ghost btn-icon btn-sm" aria-label="Search body" aria-keyshortcuts="${aks('mod', 'F')}">${ico('search', 'i i-sm')}</button>
          ${copyBtn('Copy body', { state: q.copied === 'body' ? 'copied' : 'idle', keys: aks('alt', 'mod', 'C') })}
        </div>
        ${json.large && !schemaView ? `<div class="inline-note flush large-note" role="note">${ico('info', 'i i-sm')}<span>${t('json.large', { size: window.i18n.unit(json.bytes / 1024, 'kilobyte', 0), n: json.total })}</span></div>` : ''}
        ${bodyFailed ? `<div class="inline-note danger flush" role="alert">${ico('alert', 'i i-sm')}<span><strong>Couldn’t copy.</strong> Clipboard access was blocked. The body is selected: press ${kbd('mod', 'C')}.</span><button class="btn btn-ghost btn-icon btn-xs" aria-label="Dismiss">${ico('x', 'i i-sm')}</button></div>` : ''}
        ${schemaView ? `<div class="schema-pane">
            <div class="schema-legend"><span><span class="sw ok"></span>In this response</span><span><span class="sw"></span>Documented, not returned</span><span class="spacer"></span><a class="type-link" href="#">Open Order model ${ico('arrow-right', 'i i-sm')}</a></div>
            ${window.TB.schema.tree('Order', { compact: true })}
          </div>`
          : json.html}
      </div>
      <div class="timing" aria-label="Timing: 84 milliseconds in total">
        <div class="timing-bar" aria-hidden="true"><span style="flex:4;background:var(--text-3)"></span><span style="flex:21;background:var(--accent)"></span><span style="flex:52;background:var(--ok)"></span><span style="flex:7;background:var(--warn)"></span></div>
        <div class="timing-legend"><span><i style="background:var(--text-3)"></i>Auth ${num(4)} ms</span><span><i style="background:var(--accent)"></i>Handler ${num(21)} ms</span><span><i style="background:var(--ok)"></i>Database ${num(52)} ms</span><span><i style="background:var(--warn)"></i>Serialise ${num(7)} ms</span></div>
      </div>`;
  }

  /* ---------- Database ---------- */
  function database() {
    if (run === 'none') return state({
      icon: 'db', title: 'Database changes will appear here',
      body: readOnly ? 'GET requests shouldn’t write. If this one does, every insert, update and delete shows here.'
        : 'Preview runs the request inside a transaction, lists every row it would insert, update or delete, then rolls back.',
      extra: ghost([['plus', '30%', '12%'], ['edit', '42%', '18%']]),
      actions: [readOnly ? btnSend : btnPreview],
    });
    if (run === 'send' && !traced) return state({
      icon: 'db', title: 'Send doesn’t capture database changes',
      body: 'Send commits for real, and Sendproof stays out of the transaction. Use Preview to see the rows first, or turn on traced Send to record them as they’re committed.',
      actions: [btnPreview, `<button class="btn btn-sm">Turn on traced Send</button>`],
      why: 'Traced Send adds about 5 ms per query. It’s on by default in Development; turn it off when Send must behave exactly like a real client.',
    });
    if (run === '401') return state({
      icon: 'db', title: 'No database changes',
      body: 'The API rejected the request with 401 before it reached the database.',
    });
    return `
      ${traced
        ? `<div class="banner banner-ok">${ico('check')}<div><strong>${t('committed.title')}</strong> ${t('committed.body', { db: '<code class="ltr">store-demo.db</code>' })}</div><button class="btn btn-ghost btn-xs">Turn off traced Send</button></div>`
        : `<div class="banner">${ico('undo')}<div><strong>${t('rolled.title')}</strong> ${t('rolled.body', { db: '<code class="ltr">store-demo.db</code>' })}</div></div>`}
      <article class="table-change" aria-label="Orders: 1 row inserted">
        <div class="tc-head"><span class="op-badge op-ins">+ INSERT</span><span class="name">Orders</span><span class="spacer"></span><span class="faint">${t('rows', { n: 1 })}</span></div>
        <div class="kv">
          <div class="k">Id</div><div class="v new ltr">7d2e41a0-5c1b-4e8f-a3d2-6b0e19c49f13</div>
          <div class="k">Status</div><div class="v new">Pending</div>
          <div class="k">Amount</div><div class="v new">79.00</div>
          <div class="k">Currency</div><div class="v new">EUR</div>
          <div class="k">DeliverBy</div><div class="v new">2026-11-23</div>
        </div>
        <button class="more-cols">${ico('chevron-down', 'i i-sm')}${t('more.cols', { n: 9 })}</button>
      </article>
      <article class="table-change" aria-label="StockLevels: 1 row updated">
        <div class="tc-head"><span class="op-badge op-upd">~ UPDATE</span><span class="name">StockLevels</span><span class="spacer"></span><span class="faint" lang="en">Merino Crew Sweater, Heather Grey / M</span></div>
        <div class="kv">
          <div class="k">Reserved</div><div class="v"><span class="old">6</span><span class="arrow" aria-hidden="true">→</span><span class="sr-only">changed to</span>7</div>
          <div class="k">Available</div><div class="v"><span class="old">78</span><span class="arrow" aria-hidden="true">→</span><span class="sr-only">changed to</span>77</div>
        </div>
      </article>
      <div class="effect">${ico('mail')}<div class="grow"><div class="t">${traced ? t('email.sent', { n: 1 }) : t('email.held', { n: 1 })}</div><div class="s ltr">OrderPlacedNotification → store-ops@acme.dev</div></div><button class="btn btn-ghost btn-sm">${t('view')}</button></div>`;
  }

  /* ---------- Side effects ---------- */
  function effects() {
    if (run === 'none') return state({
      icon: 'mail', title: 'Side effects will appear here',
      body: 'Emails, outbound HTTP calls, background jobs and messages this request triggers. Preview holds them back; Send lets them run.',
      extra: ghost([['mail', '38%', '14%'], ['globe', '52%', '20%'], ['clock', '30%', '16%']]),
      actions: [readOnly ? btnSend : btnPreview],
    });
    if (run === 'send' && !traced) return state({
      icon: 'mail', title: 'Send doesn’t capture side effects',
      body: 'They ran for real using the Development connections. Preview shows them without sending, or turn on traced Send to record them as they happen.',
      actions: [btnPreview, `<button class="btn btn-sm">Turn on traced Send</button>`],
    });
    if (run === '401' || q.effects === 'zero') return state({
      icon: 'check', title: 'No side effects',
      body: run === '401' ? 'The request was rejected before any code ran, so nothing was sent or queued.' : 'This request sent no emails, made no outbound HTTP calls and queued no jobs or messages.',
    });
    const rows = [
      ['mail', 'Email', 'OrderPlacedNotification', 'to store-ops@acme.dev', traced ? 'Delivered' : 'Held'],
      ['globe', 'HTTP call', 'POST carrier-gateway.acme.dev/v1/rates', 'Quote Standard delivery · 312 B', traced ? 'Delivered' : 'Intercepted'],
      ['clock', 'Background job', 'ReserveStockJob', 'Hangfire · queue orders', traced ? 'Queued' : 'Discarded on rollback'],
      ['send', 'Message', 'order.created', 'Service Bus · topic orders', traced ? 'Delivered' : 'Held'],
    ];
    return `${traced
      ? `<div class="banner banner-ok">${ico('send')}<div><strong>These ran for real.</strong> Traced Send recorded the 4 effects this request triggered as they happened.</div></div>`
      : `<div class="banner">${ico('undo')}<div><strong>Nothing left the API.</strong> Sendproof captured these 4 effects and held them back. Send runs them for real.</div></div>`}
      <div class="fx-list">${rows.map(([i, kind, title, sub, status]) => `
        <article class="fx"><button class="fx-head" aria-expanded="false"><span class="fx-ico">${ico(i, 'i i-sm')}</span>
          <span class="stack"><span class="kind">${kind}</span><span class="title ltr">${title}</span><span class="sub">${sub}</span></span>
          <span class="tag">${status}</span>${ico('chevron-right', 'i i-sm faint')}</button></article>`).join('')}</div>`;
  }

  /* ---------- Logs ---------- */
  function logs() {
    if (run === 'none') return state({
      icon: 'list', title: 'Logs for this request will appear here',
      body: 'Only entries from this request’s scope: ASP.NET Core, your own ILogger calls and every EF Core SQL command with its parameters.',
      extra: ghost([['info', '64%', '8%'], ['db', '48%', '8%'], ['info', '56%', '8%']]),
      actions: [readOnly ? btnSend : btnPreview],
    });
    const p = (k, v) => `<span class="prop" title="${k}">${v}</span>`;
    const all = run === '401' ? [
      ['0.0', 'INF', 'Hosting', `Request starting <code>GET /api/v2/orders</code>`],
      ['0.9', 'INF', 'Authentication', `${p('Scheme', 'Cookies')} was not authenticated. No cookie.`],
      ['1.4', 'INF', 'Hosting', `Request finished <code>GET /api/v2/orders</code> responded ${p('StatusCode', '401')} in ${p('Elapsed', '2 ms')}`],
    ] : [
      ['0.0', 'INF', 'Hosting', `Request starting <code>POST /api/v2/orders</code> 412 bytes`],
      ['1.2', 'INF', 'Auth', `Signed in as ${p('User', 'ada.admin@acme.dev')} with roles ${p('Roles', 'admin')}`],
      ['9.6', 'SQL', 'EF Core', `<code>SELECT c.Id, c.Name, c.Email FROM Customers AS c WHERE c.Id = @p0</code>`, '3.1'],
      ['21.0', 'WRN', 'StockPolicy', `${p('Available', '77')} units of APP-MCS-HGR-M left, below the reorder point ${p('ReorderPoint', '90')}`],
      ['33.4', 'SQL', 'EF Core', `<code>INSERT INTO Orders (Id, Status, Amount, Currency, DeliverBy) VALUES (@p0, @p1, @p2, @p3, @p4)</code>`, '6.2', true],
      ['41.0', 'SQL', 'EF Core', `<code>UPDATE StockLevels SET Reserved = Reserved + @p0 WHERE VariantId = @p1</code>`, '4.4'],
      ['52.8', 'INF', 'OrderService', `Created order ${p('OrderId', '7d2e41a0…9f13')}`],
    ];
    const filteredOut = q.logs === 'empty';
    const bar = `<div class="log-bar">
        <div class="segmented" role="group" aria-label="Level"><button aria-pressed="${!filteredOut}">All <span class="faint">${run === '401' ? 3 : 11}</span></button><button aria-pressed="false">Warning <span class="faint">${run === '401' ? 0 : 1}</span></button><button aria-pressed="${filteredOut}">Error <span class="faint">0</span></button></div>
        <label class="input-sm grow">${ico('filter', 'i i-sm')}<span class="sr-only">Filter logs</span><input placeholder="Filter messages or properties" value="${filteredOut ? 'timeout' : ''}"></label>
        ${copyBtn('Copy logs as JSON')}
      </div>`;
    if (filteredOut) return bar + state({
      icon: 'filter', compact: true, title: 'No log entries match',
      body: 'All 11 entries are hidden by your filters: level <strong>Error</strong> and text “timeout”.',
      actions: [`<button class="btn btn-sm">Clear filters ${kbd('Esc')}</button>`, `<button class="btn btn-ghost btn-sm">Show all levels</button>`],
    });
    const sqlCopied = q.copied === 'sql';
    return bar + `<div class="logs ltr" role="table" aria-label="Log entries">
        <div class="log-row head" role="row"><span role="columnheader"></span><span role="columnheader">ms</span><span role="columnheader">Level</span><span role="columnheader">Took</span><span role="columnheader">Source</span><span role="columnheader">Message</span></div>
        ${all.map(([tm, lvl, src, msg, took, open]) => `
          <div class="log-row lvl-${lvl.toLowerCase()}${open ? ' is-open' : ''}" role="row" aria-expanded="${!!open}">
            <span role="cell" class="chev">${ico(open ? 'chevron-down' : 'chevron-right', 'i i-sm')}</span><span role="cell" class="tm">${tm}</span>
            <span role="cell"><span class="lvl">${lvl}</span></span><span role="cell" class="tm">${took || ''}</span><span role="cell" class="src">${src}</span><span role="cell" class="msg">${msg}</span>
          </div>${open ? `<div class="log-detail" role="row"><div role="cell">
<div class="sql-wrap"><div class="sql-bar">SQL with parameter values · 6.2 ms · 1 row<span class="spacer"></span>${copyBtn('Copy SQL with values', { state: sqlCopied ? 'copied' : 'idle', size: 'btn-xs' })}</div><pre class="sql"><span class="tok-k">INSERT INTO</span> Orders (Id, Status, Amount, Currency, DeliverBy)
<span class="tok-k">VALUES</span> ('7d2e41a0-…', 'Pending', 79.00, 'EUR', '2026-11-23');</pre></div>
          </div></div>` : ''}`).join('')}
      </div>`;
  }

  /* ---------- Headers ---------- */
  function headers() {
    if (run === 'none') return state({
      icon: 'list', title: 'Response headers will appear here',
      body: 'Every header the API returns, plus the request headers exactly as they were sent, after variables were resolved.',
      extra: ghost([['hash', '28%', '40%'], ['hash', '22%', '34%']]),
      actions: [readOnly ? btnSend : btnPreview],
    });
    const rows = run === '401'
      ? [['WWW-Authenticate', 'Cookie realm="StoreApi"'], ['Content-Length', '0'], ['Date', 'Fri, 20 Nov 2026 14:02:11 GMT']]
      : [['Location', '/api/v2/orders/7d2e41a0-5c1b-4e8f-a3d2-6b0e19c49f13'], ['Content-Type', 'application/json; charset=utf-8'], ['Content-Length', '1214'], ['ETag', 'W/"1"'],
         ['X-Request-ID', '0c5d9a2e-1f4b-4c39-8e0a-b7d2c61f5a08'], ['Idempotency-Replayed', 'false'], ['traceparent', '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'], ['Date', 'Fri, 20 Nov 2026 14:02:11 GMT'], ['Server', 'Kestrel']];
    return `<div class="section-label">Response headers <span class="schema">${rows.length}</span><span class="rule" aria-hidden="true"></span>
        ${copyTextBtn('Copy all', { state: q.copied === 'headers' ? 'copied' : 'idle', cls: 'btn-xs btn-ghost' })}</div>
      <dl class="hdr-list ltr">${rows.map(([k, v]) => `<div class="hdr"><dt>${k}</dt><dd><span class="v">${v}</span></dd></div>`).join('')}</dl>
      <button class="fx-head collapsed-section" aria-expanded="false">${ico('chevron-right', 'i i-sm faint')}<span class="title">Request headers as sent</span><span class="faint">${run === '401' ? 2 : 5}</span></button>`;
  }

  /* ---------- Head row ---------- */
  const signedOut = q.auth === 'out';
  const head = {
    none: `<span class="faint">${t('res.none')}</span><span class="spacer"></span>`,
    running: `<span class="pill pill-accent"><span class="spinner" aria-hidden="true"></span>${t('res.preview')}</span><span class="faint">Running as Ada Admin…</span><span class="metric">0.4 s</span><span class="spacer"></span><button class="btn btn-ghost btn-sm">${t('cancel')} ${kbd('Esc')}</button>`,
    preview: `<span class="pill pill-accent">${ico('flask', 'i i-sm')}${t('res.preview')}</span><span class="status-code ok">${ico('check', 'i i-sm')}201 Created</span>${metrics(84, 1.2)}<span class="spacer"></span>${copyBtn(t('copy.curl'), { keys: aks('shift', 'mod', 'C') })}<button class="btn btn-sm">${ico('send', 'i i-sm')}${t('send.real')}</button>`,
    send: readOnly
      ? `<span class="pill pill-ok">${ico('send', 'i i-sm')}${t(traced ? 'res.traced' : 'res.sent')}</span><span class="status-code ok">${ico('check', 'i i-sm')}200 OK</span>${metrics(q.body === 'large' ? 38 : 12, q.body === 'large' ? 96 : 1.4)}<span class="spacer"></span>${copyBtn('Copy as cURL')}`
      : `<span class="pill pill-ok">${ico('send', 'i i-sm')}${t(traced ? 'res.traced' : 'res.sent')}</span><span class="status-code ok">${ico('check', 'i i-sm')}201 Created</span>${metrics(91, 1.2)}<span class="spacer"></span>${copyBtn('Copy as cURL')}<button class="btn btn-sm">${t('open.order')} ${kbd('mod', 'G')}</button>`,
    401: `<span class="pill pill-ok">${ico('send', 'i i-sm')}${t('res.sent')}</span><span class="status-code err">${ico('lock', 'i i-sm')}401 Unauthorized</span>${metrics(2, 0)}<span class="spacer"></span>${copyBtn('Copy as cURL')}`,
    neterror: `<span class="pill pill-danger">${ico('wifi-off', 'i i-sm')}No response</span><span class="metric">after 30 s</span><span class="spacer"></span>`,
  }[run];

  // The result bar: when and how the shown result was produced, and the way to older runs.
  const runLabel = { preview: t('bar.previewRun'), send: traced ? t('bar.sendTraced') : t('bar.sendRun'), 401: t('bar.sendRun') }[run];
  const resultBar = `<span class="bar-text">${ico(run === 'none' || run === 'running' || run === 'neterror' ? 'clock' : run === 'preview' ? 'undo' : 'send', 'i i-sm')}<span>${
    run === 'none' ? t('bar.noRuns') : run === 'running' ? t('bar.runningShort') : run === 'neterror' ? t('bar.noResponse') : t('bar.lastRun', { what: runLabel, time: '14:02:11' })}</span></span>
    <button class="btn btn-ghost btn-sm" aria-keyshortcuts="Meta+Y">${ico('history', 'i i-sm')}${t('history')}${kbd('mod', 'Y')}</button>`;
  const keys = ['response', 'database', 'effects', 'logs', 'headers'];
  const labels = ['res.response', 'res.database', 'res.effects', 'res.logs', 'res.headers'];
  let content = { response, database, effects, logs, headers }[rtab]();
  if (run === 'running') content = `<div aria-busy="true">${rtab === 'response'
    ? `<div class="viewer" aria-hidden="true"><div class="viewer-bar"><span class="sk" style="inline-size:11rem;block-size:1.6rem"></span></div><div class="code-view">${[30, 62, 40, 48, 36, 70, 74, 55, 30].map((w, i) => `<div class="ln"><span class="no">${i + 1}</span><span></span><span class="src" style="--d:${i ? 1 : 0}"><span class="sk sk-line" style="inline-size:${w}%"></span></span></div>`).join('')}</div></div>`
    : ''}<span class="sr-only">Loading result</span></div>`;

  return `
  <section class="pane response" aria-labelledby="resp-title">
    <h2 id="resp-title" class="sr-only">Result</h2>
    <div class="resp-head" role="status" aria-live="polite">${head}</div>
    ${run === 'running' ? '<div class="progress" aria-hidden="true"></div>' : ''}
    <div class="tabs scrolls" role="tablist" aria-label="Result">
      ${keys.map((k, i) => tab(t(labels[i]), { selected: k === rtab, count: counts[i], keys: `Shift+Alt+${i + 1}` })).join('')}
    </div>
    <div class="pane-scroll" role="tabpanel"><div class="result-body">${content}</div></div>
    <div class="pane-bar result-bar">${resultBar}</div>
    <div class="sr-only" aria-live="polite">${{ body: 'Body copied', sql: 'SQL copied', headers: 'Headers copied', bodyfailed: 'Couldn’t copy. The body is selected; press Command C.' }[q.copied] || ''}</div>
  </section>`;
  }
  window.TB.buildResult = build;
  const host = document.querySelector('[data-shell="response"]');
  const q0 = window.TB.q;
  if (host && !['docs', 'model', 'overview'].includes(q0.view)) host.outerHTML = build(q0);
})();
