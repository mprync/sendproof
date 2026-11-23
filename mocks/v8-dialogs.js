// v8 (?v8=1, on top of v7): the workbench's own dialogs. The workbench never uses a native browser
// dialog (confirm, alert, prompt); every question or notice it has to put in front of the person is
// one of these, in the workbench's own style, so it can show what will happen rather than a line
// of text.
//
// Dialogs (?dlg=…), each over the v7 journey screen it belongs to:
//   sendrun   Send a journey run for real: what each store will keep, in which environment
//   endrun    End a Preview run partway: the held session and what rolling back undoes
//   stopsend  Stop a Send run partway: what earlier steps already wrote, and how to undo it
//   persona   Switch persona while a Preview session is held: the session ends with it
//   expired   The Preview session ended on its own (idle timeout): nothing was written
// Phones (?mview=…, text=130) show each as a bottom sheet.
(function () {
  const TB = window.TB;
  const { q, ico, kbd } = TB;
  if (!q.v8 || !q.dlg) return;
  if (!document.querySelector('link[href="v8.css"]')) document.write('<link rel="stylesheet" href="v8.css">');
  const logo = window.SP?.logo || (() => '');
  const ltr = s => `<bdi dir="ltr">${s}</bdi>`;

  /** One row of a dialog's list: a mark, a name with a subtitle under it, and an optional end. */
  const row = (mark, name, sub, end = '') => `<li class="dl8-row">${mark}<span class="dl8-text"><span class="dl8-name">${name}</span><span class="dl8-sub">${sub}</span></span>${end}</li>`;
  const mark = (icon, tone = '') => `<span class="dl8-mark${tone ? ` is-${tone}` : ''}" aria-hidden="true">${ico(icon, 'i i-sm')}</span>`;
  const env = `<span class="dl8-env"><span class="dot" aria-hidden="true"></span>Development<span class="dl8-env-db">${ltr('store-demo.db')}</span></span>`;

  function dialog({ id, tone, icon, head, title, body, content = '', foot = '', actions }) {
    return `<div class="dl8-scrim" data-dialog="${id}">
      <div class="dl8" role="${tone === 'danger' || tone === 'warn' ? 'alertdialog' : 'dialog'}" aria-modal="true" aria-labelledby="dl8-${id}-t" aria-describedby="dl8-${id}-d">
        <span class="dl8-grab" aria-hidden="true"></span>
        <header class="dl8-head">
          ${head || `<span class="dl8-tile is-${tone}" aria-hidden="true">${ico(icon, 'i')}</span>`}
          <div class="dl8-titles"><h2 id="dl8-${id}-t">${title}</h2><p id="dl8-${id}-d">${body}</p></div>
          <button class="btn btn-ghost btn-icon btn-sm dl8-close" type="button" aria-label="Close" title="Close · Esc">${ico('x', 'i i-sm')}</button>
        </header>
        ${content ? `<div class="dl8-body">${content}</div>` : ''}
        <footer class="dl8-foot"><span class="dl8-meta">${foot}</span><span class="dl8-actions">${actions}</span></footer>
      </div></div>`;
  }

  const DIALOGS = {
    sendrun: () => dialog({
      id: 'sendrun', tone: 'warn', icon: 'send',
      title: 'Send this run for real?',
      body: 'Order to shipment sends all 5 steps. What they write stays written.',
      content: `<p class="dl8-label"><span>Kept after the run</span>${env}</p>
        <ul class="dl8-list">
          ${row(logo('sqlite', 'lg-16'), `SQLite ${ltr('<code>store-demo.db</code>')}`, '14 rows in Orders, Payments, Shipments and 5 more tables')}
          ${row(logo('mongodb', 'lg-16'), `MongoDB ${ltr('<code>store</code>')}`, '4 documents in order_events and order_timelines')}
          ${row(mark('mail'), 'Email', `2 emails delivered to ${ltr('priya.raman@example.com')}`)}
        </ul>
        <p class="dl8-hint">${ico('flask', 'i i-sm')}<span>A Preview run checks the same steps and rolls everything back.</span></p>`,
      // Committing is never the default: focus starts on Cancel, and Enter needs the chord shown.
      actions: `<button class="btn btn-sm" type="button" autofocus>Cancel</button>
        <button class="btn btn-primary btn-sm dl8-go" type="button">${ico('send', 'i i-sm i-dir')}Send run${kbd('shift', 'mod', 'enter')}</button>`,
    }),
    endrun: () => dialog({
      id: 'endrun', tone: 'neutral', icon: 'flask',
      title: 'End this Preview run?',
      body: 'Ending the held session rolls back all 3 steps. Nothing was written.',
      content: `<ul class="dl8-list">
          ${row(mark('check', 'ok'), 'Place order', `${ltr('201')} · 64 ms · 6 rows, 1 email held`)}
          ${row(mark('check', 'ok'), 'List payments', `${ltr('200')} · 18 ms · reads only`)}
          ${row(mark('check', 'ok'), 'Capture payment', `${ltr('200')} · 71 ms · 2 rows, 1 email held`)}
        </ul>`,
      foot: `<span class="dl8-foot-note">${ico('clock', 'i i-sm')}Session held 2 min</span>`,
      actions: `<button class="btn btn-sm" type="button" autofocus>Keep running</button>
        <button class="btn btn-primary btn-sm" type="button">End run</button>`,
    }),
    stopsend: () => dialog({
      id: 'stopsend', tone: 'danger', icon: 'stop',
      title: 'Stop this Send run?',
      body: 'Steps 1 and 2 were sent for real. Stopping keeps what they wrote; steps 3 to 5 won’t run.',
      content: `<p class="dl8-label"><span>Left in the database</span>${env}</p>
        <ul class="dl8-list">
          ${row(logo('sqlite', 'lg-16'), `Orders ${ltr('<code>ORD-2026-000189</code>')}`, 'Inserted by step 1 · Pending')}
          ${row(logo('sqlite', 'lg-16'), `Payments ${ltr('<code>PAY-2026-000357</code>')}`, 'Inserted by step 1 · Authorized')}
          ${row(logo('sqlite', 'lg-16'), 'StockReservations', 'Inserted by step 1 · 2 units of APP-MCS-HGR-M')}
        </ul>
        <button class="dl8-undo" type="button"><span class="method m-post">POST</span><span class="dl8-text"><span class="dl8-name">Cancel order</span><span class="dl8-sub">Releases the units and voids the payment</span></span>${ico('arrow-right', 'i i-sm i-dir')}</button>`,
      actions: `<button class="btn btn-sm" type="button" autofocus>Keep going</button>
        <button class="btn btn-sm dl8-danger" type="button">${ico('stop', 'i i-sm')}Stop run</button>`,
    }),
    // Switching persona is about who the person becomes, so the two people are the dialog: each a
    // card with what that persona can do in this journey, at a glance, as one segment per step.
    persona: () => {
      const STEPS = ['Place order', 'List payments', 'Capture payment', 'Ship order', 'Get order'];
      const access = refused => `<span class="dl8-steps" role="img" aria-label="${STEPS.length - refused.length} of ${STEPS.length} steps allowed">${STEPS.map((s, i) => `<span class="dl8-seg${refused.includes(i) ? ' is-no' : ''}" title="${i + 1}. ${s}${refused.includes(i) ? ' · refused (403)' : ''}"></span>`).join('')}</span>`;
      const card = ({ ini, name, role, alt, now, refused }) => `<div class="dl8-pc${now ? ' is-now' : ' is-next'}">
          <span class="dl8-pc-tag">${now ? `${ico('flask', 'i i-sm')}Preview held` : 'Switching to'}</span>
          <span class="dl8-pc-who"><span class="avatar dl8-av${alt ? ' is-alt' : ''}" aria-hidden="true">${ini}</span>
            <span class="dl8-text"><span class="dl8-name">${name}</span><span class="dl8-sub"><span class="dl8-role">${role}</span></span></span></span>
          <span class="dl8-pc-access">${access(refused)}<span class="dl8-pc-count">${STEPS.length - refused.length} of ${STEPS.length}</span></span>
        </div>`;
      return dialog({
        id: 'persona', tone: 'neutral', icon: 'user',
        head: `<span class="dl8-pair" aria-hidden="true"><span class="avatar dl8-av is-alt">SS</span><span class="dl8-pair-badge">${ico('refresh', 'i')}</span></span>`,
        title: 'Switch to Sam Support?',
        body: 'Your Preview run as Ada Admin ends, and its 3 held steps roll back.',
        content: `<div class="dl8-people">
            ${card({ ini: 'AA', name: 'Ada Admin', role: 'admin', now: true, refused: [] })}
            <span class="dl8-hop" aria-hidden="true">${ico('arrow-right', 'i i-sm i-dir')}</span>
            ${card({ ini: 'SS', name: 'Sam Support', role: 'support', alt: true, refused: [2, 3] })}
          </div>
          <ul class="dl8-list">
            ${row(mark('lock', 'warn'), '2 steps are refused', 'Capture payment and Ship order return 403 for support')}
          </ul>`,
        foot: `<span class="dl8-foot-note">${ico('undo', 'i i-sm')}Rolls back 3 held steps</span>`,
        actions: `<button class="btn btn-sm" type="button" autofocus>Stay as Ada</button>
          <button class="btn btn-primary btn-sm" type="button">Switch and end run</button>`,
      });
    },
    expired: () => dialog({
      id: 'expired', tone: 'warn', icon: 'clock',
      title: 'The Preview session ended',
      body: 'It was idle for 5 minutes, so Sendproof rolled it back. Nothing was written.',
      content: `<ul class="dl8-list">
          ${row(mark('check', 'ok'), 'Steps 1 to 3 had run', 'Their results stay in this run')}
          ${row(mark('undo'), 'Rolled back at 14:09:12', `SQLite ${ltr('store-demo.db')} and MongoDB ${ltr('store')}`)}
        </ul>`,
      actions: `<button class="btn btn-sm" type="button">Close</button>
        <button class="btn btn-primary btn-sm" type="button" autofocus>${ico('refresh', 'i i-sm')}Start again</button>`,
    }),
  };

  const build = DIALOGS[q.dlg];
  if (!build) return;
  // The v7 scene renders first (it is written in before this script); the dialog goes over it.
  addEventListener('DOMContentLoaded', () => {
    document.body.insertAdjacentHTML('beforeend', build());
    document.querySelector('.workspace')?.setAttribute('inert', '');
    document.querySelector('.topbar')?.setAttribute('inert', '');
  });
  document.title = 'Sendproof · v8 dialogs mock';
})();
