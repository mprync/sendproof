// v6 boards (stores.html?v6=1&set=…), built with the screens' own builders:
//   icons      every store mark at the sizes the workbench uses, with its id, mode and nouns,
//              then the marks in place (group head, log source, filter chip, blocked tile)
//   documents  the five MongoDB change kinds side by side at the result pane's width:
//              insert, update, upsert (an insert), replace (an update) and delete
(function () {
  const { q, ico } = window.TB;
  const { logo, stores, docCard } = window.SP;
  const root = document.getElementById('board');
  if (!root || !q.v6) return;
  document.body.classList.add('board6');

  if ((q.set || 'icons') === 'icons') {
    const sections = [
      ['SQL providers', 'Existing: rows in a transaction that Preview rolls back', ['sqlite', 'postgresql', 'mysql', 'mariadb', 'sqlserver']],
      ['Batch one', 'MongoDB previews in a transaction; Redis and DynamoDB are guarded', ['mongodb', 'redis', 'dynamodb']],
      ['Batch two', 'Guard only: reads run, the first write blocks the Preview', ['cassandra', 'elasticsearch', 'opensearch', 'cosmosdb', 'firestore']],
      ['Fallback', 'A store Sendproof has no mark for keeps the same layout', ['other']],
    ];
    const ids = { sqlite: 'sqlite', postgresql: 'postgresql', mysql: 'mysql', mariadb: 'mariadb', sqlserver: 'mssql', mongodb: 'mongodb', redis: 'redis', dynamodb: 'dynamodb', cassandra: 'cassandra', elasticsearch: 'elasticsearch', opensearch: 'opensearch', cosmosdb: 'cosmosdb', firestore: 'firestore', other: '—' };
    const row = id => {
      const st = stores[id];
      const [container, record, key] = st.nouns;
      return `<div class="lgt-row">
        <span class="lgt-sizes">${logo(id, 'lg-14')}${logo(id, 'lg-16')}${logo(id, 'lg-20')}<span class="lgt-tile">${logo(id, 'lg-28')}</span></span>
        <span class="lgt-name"><strong>${st.name}</strong><code>${ids[id]}</code></span>
        <span class="lgt-kind">${st.kind}</span>
        ${id === 'other' ? '<span class="lgt-mode is-guard">Guard</span>' : `<span class="lgt-mode is-${st.mode}">${ico(st.mode === 'preview' ? 'undo' : 'ban', 'i i-sm')}${st.mode === 'preview' ? 'Preview' : 'Guard only'}</span>`}
        <span class="lgt-nouns">${container} · ${record} · <code>${key}</code></span>
      </div>`;
    };
    root.innerHTML = `<div class="bd6">
      <header class="bd6-h"><h1>Store marks</h1>
        <p>Each store Sendproof can hook, at the sizes the workbench uses: 14 px in log rows and filter chips, 16 px in lists, 20 px in a store group’s head and 28 px in a tile. The name always sits beside the mark, so nothing depends on the logo. The columns give the id from <code>dataStores[].system</code>, the mode and what the change list calls a container, a record and its key. Drawn for the mocks after each vendor’s official mark; at implementation use the vendor’s own SVG.</p></header>
      ${sections.map(([title, sub, list]) => `<section class="bd6-sec"><h2>${title}<span>${sub}</span></h2>
        <div class="lgt"><div class="lgt-row head"><span>14 · 16 · 20 · 28 px</span><span>Store and id</span><span>Kind</span><span>Mode</span><span>Container · record · key</span></div>${list.map(row).join('')}</div></section>`).join('')}
      <section class="bd6-sec"><h2>In place<span>The same marks inside the components that use them</span></h2>
        <div class="bd6-use">
          <div><p class="bd6-cap"><strong>Store group</strong> · 20 px</p><div class="sg6-head" style="border:0;padding:0">${logo('mongodb', 'lg-20')}<h3>MongoDB</h3><code>store</code><span class="sg6-state">${ico('undo', 'i i-sm')}Transaction aborted</span></div></div>
          <div><p class="bd6-cap"><strong>Jump strip</strong> · 14 px</p><div class="ss6"><a class="ss6-item" href="#">${logo('sqlite', 'lg-14')}<span>SQLite</span><span class="n">2 rows</span></a><a class="ss6-item" href="#">${logo('mongodb', 'lg-14')}<span>MongoDB</span><span class="n">5 documents</span></a></div></div>
          <div><p class="bd6-cap"><strong>Query filter</strong> · 14 px</p><div class="qf6" style="margin:0">${['redis', 'dynamodb', 'cassandra', 'elasticsearch'].map((id, i) => `<button class="qc6" aria-pressed="${i < 2}">${logo(id, 'lg-14')}<span>${stores[id].name}</span><span class="n">${[2, 1, 4, 3][i]}</span></button>`).join('')}</div></div>
          <div><p class="bd6-cap"><strong>Log source</strong> · 14 px</p><span class="src6" style="font-size:var(--fs-md);color:var(--text-3)">${logo('cosmosdb', 'lg-14')}<span>Cosmos DB</span></span></div>
          <div><p class="bd6-cap"><strong>Blocked tile</strong> · 28 px</p><span class="blk6-tile">${logo('firestore', 'lg-28')}<span class="blk6-badge">${ico('ban', 'i i-sm')}</span></span></div>
          <div><p class="bd6-cap"><strong>Docked reason</strong> · 20 px</p><span class="pv6-tile">${logo('opensearch', 'lg-20')}</span></div>
        </div></section>
    </div>`;
    return;
  }

  // Documents: the five change kinds at the result pane's width (37rem ≈ 592 px at 1440).
  const caps = {
    orders: '<strong>Update</strong> · nested fields and arrays: every object open, changed paths tinted, arrays by index',
    order_events: '<strong>Insert</strong> · a new document, every field marked +',
    customer_profiles: '<strong>Upsert</strong> · the change record says insert; the command’s <code>upsert</code> adds “via upsert”',
    review_invites: '<strong>Replace</strong> · the change record says update; a replacement document adds “whole document replaced”',
    stock_holds: '<strong>Delete</strong> · the document as it was, every field marked −',
  };
  const order = ['order_events', 'orders', 'customer_profiles', 'review_invites', 'stock_holds'];
  const cards = order.map(n => window.SP.docs.find(d => d.collection === n));
  root.innerHTML = `<div class="bd6">
    <header class="bd6-h"><h1>Document changes in a Preview</h1>
      <p>MongoDB changes say collection, document and field. Every object starts open; a Diff, Before and After switch sits on updates. Extended JSON values (<code>$oid</code>, <code>$date</code>, <code>$numberDecimal</code>) read as typed badges and secret fields as <span class="rd6">${ico('lock', 'i i-sm')}redacted</span> at any depth.</p></header>
    <div class="bd6-grid" style="grid-template-columns:repeat(2, 37rem)">
      <div class="bd6-col">${cards.slice(0, 2).map(c => `<div class="bd6-cell"><p class="bd6-cap">${caps[c.collection]}</p>${docCard(c)}</div>`).join('')}</div>
      <div class="bd6-col">${cards.slice(2).map(c => `<div class="bd6-cell"><p class="bd6-cap">${caps[c.collection]}</p>${docCard(c)}</div>`).join('')}</div>
    </div>
  </div>`;
})();
