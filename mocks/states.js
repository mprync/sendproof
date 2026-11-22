// Whole-page states for the v3 mocks, rendered instead of the workbench:
//   view=signin (signin=error500|wrong)  boot=loading|error
// Loading and error pages mirror the final layout, so nothing jumps when the spec arrives.
(function () {
  const { q, ico, kbd, state } = window.TB;
  const app = document.querySelector('.app');

  if (q.view === 'signin') {
    const err500 = q.signin === 'error500', wrong = q.signin === 'wrong';
    document.querySelector('.skip-link').remove();
    app.outerHTML = `
    <div class="sign-page">
      <header class="bar">
        <div class="brand"><span class="brand-mark" aria-hidden="true">${ico('bench')}</span>Sendproof</div>
        <span class="crumb-sep desktop-only" aria-hidden="true">/</span><span class="desktop-only" lang="en">Acme Store API</span>
        <span class="spacer"></span>
        <span class="pill pill-ok desktop-only"><span class="dot" aria-hidden="true"></span>Development · <span class="ltr">store-demo.db</span></span>
        <button class="btn btn-ghost btn-sm">${ico('arrow-left', 'i i-sm')}<span class="desktop-only">Back to workbench</span><span class="mobile-only">Back</span> ${kbd('Esc')}</button>
      </header>
      <main class="sign-main">
        <div class="sign-layout">
          <section aria-labelledby="sign-title">
            <h1 id="sign-title">Sign in to Acme Store API</h1>
            <p class="lede">You’ll call the API as this user, with their roles and data.</p>
            ${err500 ? `
            <div class="err-panel" role="alert" aria-labelledby="err-title">
              <div class="top">${ico('alert')}<div><h2 id="err-title">The API couldn’t sign you in</h2>
                <p>It returned <strong>500</strong> while creating the sign-in cookie. Your email and password were accepted; the server failed after that.</p></div></div>
              <ol class="todo">
                <li>Try again. If it fails twice, it’s the server, not you.</li>
                <li>Look in the API console for a <code>CryptographicException</code>: the Data Protection key ring can’t be read.</li>
                <li>Point <code>DemoKeyDirectory</code> at a writable folder, or remove the unreadable key file, then restart the API.</li>
              </ol>
              <div class="acts"><button class="btn btn-primary btn-sm">${ico('refresh', 'i i-sm')}Try again ${kbd('mod', 'enter')}</button><button class="btn btn-sm">Use a seeded account</button></div>
              <details class="details" ${q.details ? 'open' : ''}>
                <summary>${ico('chevron-right', 'i i-sm')}Technical details<span class="spacer"></span><span class="faint" style="font-weight:400">500 · trace 4bf92f35</span></summary>
                <div class="details-acts">${window.TB.copyTextBtn('Copy details', { cls: 'btn-xs' })}</div>
                <dl class="facts">
                  <dt>Request</dt><dd>POST /auth/login</dd>
                  <dt>Status</dt><dd>500 Internal Server Error · 38 ms</dd>
                  <dt>Trace ID</dt><dd>00-4bf92f3577b34da6a3ce929d0e0e4736-01</dd>
                  <dt>Time</dt><dd class="plain">20 Nov 2026, 14:02:11</dd>
                </dl>
                <pre>System.Security.Cryptography.CryptographicException: An error occurred while trying to encrypt the provided data.
 ---> System.UnauthorizedAccessException: Access to the path '~/.aspnet/DataProtection-Keys/key-18031b98-….xml' is denied.</pre>
              </details>
            </div>` : ''}
            <form class="form" style="padding:0;gap:0.25rem" onsubmit="return false" novalidate>
              <div class="field"><span class="label"><label for="s-email">Email or username</label></span>
                <div class="control"><span class="lead">${ico('at', 'i i-sm')}</span><input id="s-email" value="${err500 || wrong ? 'ada.admin@acme.dev' : ''}" autocomplete="username"><span class="slot"></span></div><div class="assist"></div></div>
              <div class="field"><span class="label"><label for="s-pw">Password</label><span class="type">via POST /auth/login</span></span>
                <div class="control${wrong ? ' is-invalid' : ''}"><input id="s-pw" type="password" value="${err500 || wrong ? 'Demo123!' : ''}" autocomplete="current-password" ${wrong ? 'aria-invalid="true" aria-describedby="s-pw-a"' : ''}><button type="button" class="slot wand" aria-label="Show password">${ico('eye', 'i i-sm')}</button></div>
                <div class="assist${wrong ? ' is-error' : ''}" id="s-pw-a">${wrong ? `${ico('alert', 'i i-sm')}<span class="msg">Wrong email or password. Seeded accounts use <code>Demo123!</code></span>` : ''}</div></div>
              <button class="btn btn-primary btn-block" style="margin-block-start:0.5rem">${ico('log-in', 'i i-sm')}Sign in</button>
            </form>
          </section>
          <section class="persona-card" aria-labelledby="seeded">
            <div class="h"><strong id="seeded">${ico('user', 'i i-sm')}Seeded accounts</strong><p>Sign in as an existing user in <code>store-demo.db</code>. One click, no password.</p></div>
            ${[['AA', 'Ada Admin', 'admin', 'ada.admin@acme.dev'], ['SS', 'Sam Support', 'support', 'sam.support@acme.dev'], ['CC', 'Cara Customer', 'customer', 'cara.customer@acme.dev']].map(([i, n, r, e]) => `
            <button class="persona-row fx-head" style="min-block-size:3.5rem"><span class="avatar" aria-hidden="true">${i}</span><span class="stack"><span><strong style="font-weight:500">${n}</strong> <span class="tag tag-mono">${r}</span></span><span class="sub">${e}</span></span>${ico('arrow-right', 'i i-sm faint')}</button>`).join('')}
          </section>
        </div>
      </main>
    </div>`;
    return;
  }

  if (q.boot === 'loading' || q.boot === 'error') {
    const sk = (w, h = '0.7rem', extra = '') => `<span class="sk" style="display:block;inline-size:${w};block-size:${h};${extra}"></span>`;
    document.querySelector('.topbar .api-switch').innerHTML = q.boot === 'error' ? '<span lang="en">Acme Store API</span>' : '<span class="faint">Loading API…</span>';
    const side = document.querySelector('.sidebar .nav');
    side.innerHTML = [72, 58, 80, 64, 76, 50, 68].map((w, i) => `<div class="nav-item" aria-hidden="true">${i % 3 === 0 ? sk('40%', '0.6rem') : `${sk('3.25rem', '1.375rem')}${sk(w + '%')}`}</div>`).join('');
    document.querySelector('.sidebar .tabs').querySelectorAll('.n').forEach(n => { n.textContent = '–'; n.classList.add('unknown'); });
    // v4: the head row and bottom bars keep their places; only their content waits for the spec.
    const foot = document.querySelector('.sidebar .side-bar');
    if (foot) foot.innerHTML = `<span class="bar-text">${sk('7rem')}</span>`;
    const crumbs = document.querySelector('.request .ctx-bar .crumbs');
    if (crumbs) crumbs.innerHTML = sk('9rem');
    const req = document.querySelector('.request'), res = document.querySelector('.response');
    if (q.boot === 'loading') {
      req.querySelector('.pane-scroll').innerHTML = `<div aria-busy="true"><div class="op-head">${sk('9rem', '0.7rem', 'margin-block:0.65rem')}${sk('16rem', '1.6rem')}${sk('24rem', '0.8rem', 'margin-block-start:0.75rem')}
        <div class="urlbar sk" style="border:0"></div></div>
        <div class="tabs" style="margin-block-start:1rem">${[3.5, 4.5, 3, 3].map(w => `<span class="tab">${sk(w + 'rem')}</span>`).join('')}</div>
        <div class="form"><div class="fields">${[1, 1, 0.5, 0.5, 1].map(w => `<div class="field${w < 1 ? ' half' : ''}">${sk('7rem', '0.8rem', 'margin-block:0.35rem')}<span class="control sk" style="border:0"></span><span class="assist"></span></div>`).join('')}</div></div>
        <span class="sr-only" role="status">Loading the OpenAPI document</span></div>`;
      req.querySelector('.actionbar').innerHTML = `<span class="status"><span class="spinner" aria-hidden="true"></span>Reading <code class="ltr">/openapi/v1.json</code>…</span><button class="btn btn-run btn-send" disabled>${ico('send', 'i i-sm')}Send</button><button class="btn btn-primary btn-run btn-preview" disabled>${ico('flask', 'i i-sm')}Preview</button>`;
      res.querySelector('.resp-head').innerHTML = sk('8rem');
      const bar = res.querySelector('.result-bar .bar-text');
      if (bar) bar.innerHTML = sk('11rem');
      res.querySelector('.result-body').innerHTML = `<div class="state">${sk('2.5rem', '2.5rem', 'border-radius:var(--r-lg)')}${sk('14rem', '1rem')}${sk('20rem')}${sk('17rem')}</div>`;
    } else {
      document.querySelector('.workspace').innerHTML = `${document.querySelector('.sidebar').outerHTML}
        <main class="pane request" style="grid-column: 2 / -1" id="request"><div class="pane-scroll">${state({
          icon: 'alert', tone: 'danger', center: true, heading: 'h1', title: 'Couldn’t load the OpenAPI document',
          body: '<code>GET /openapi/v1.json</code> returned <strong>500</strong>. Sendproof builds every screen from it, so there’s nothing to show yet.',
          why: 'Usually a startup error in the API, or <code>AddOpenApi()</code> is missing. The API console has the details.',
          actions: [`<button class="btn btn-primary">${ico('refresh', 'i i-sm')}Try again ${kbd('mod', 'R')}</button>`, `<button class="btn">Open /openapi/v1.json</button>`, window.TB.copyTextBtn('Copy error', { cls: '' })],
        })}</div></main>`;
      document.querySelector('.sidebar .nav').innerHTML = state({ icon: 'list', compact: true, title: 'No operations', body: 'They appear once the spec loads.' });
    }
  }
})();
