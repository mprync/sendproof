// v6 (?v6=1): data-store marks for the NoSQL screens, and what each store calls its parts.
//
// Every mark is drawn on a 24 × 24 grid with flat fills, no gradients and no ids, so the same
// SVG can appear many times on a page. Colours live in v6.css (.lg-<id> .a, .b, …), so a mark
// follows the theme: dark mode lifts the colours that would sink into a dark panel.
// The marks are drawn for the mocks after each vendor's official logo. At implementation, use
// the vendor's own SVG from its press kit and check its trademark guidelines (see README v6).
//
// window.SP.stores[id] = { name, kind, group, mode, nouns: [container, record, key], svg }
// window.SP.logo(id, cls) returns the mark as inline SVG; the name is always shown beside it
// as text, so no meaning depends on the logo.
(function () {
  const stores = {
    // SQL providers (existing): changes are rows, Preview rolls back the transaction.
    sqlite: { name: 'SQLite', kind: 'SQL', group: 'sql', mode: 'preview', nouns: ['Table', 'Row', 'Primary key'],
      svg: '<rect class="a" x="2" y="3" width="15" height="18" rx="2.5"/><path class="b" d="M21.6 2.4c-3.1.4-6.3 2.6-8.5 6-1.6 2.4-2.6 5.4-3 8.6l-.6 4.6 1.3-.2c.3-2.2.8-4.1 1.5-5.7 1.3.2 2.6-.2 3.6-1.1-1 .1-1.9 0-2.6-.4.6-1 1.3-1.8 2.1-2.6 1.1.1 2.1-.3 2.8-1-.7 0-1.4-.1-1.9-.4 1.6-1.6 3.2-3.2 5.3-7.8z"/>' },
    postgresql: { name: 'PostgreSQL', kind: 'SQL', group: 'sql', mode: 'preview', nouns: ['Table', 'Row', 'Primary key'],
      svg: '<path class="a o" d="M17.6 12.2c.7 2.9.5 6-.9 8.6-.4.7-1.4.5-1.5-.3-.2-1.9-.6-3.6-1.4-5.1"/><ellipse class="a o" cx="13.4" cy="9.6" rx="6.6" ry="6.1"/><ellipse class="a o" cx="7.4" cy="10.4" rx="4.1" ry="5.3"/><circle class="c" cx="15.6" cy="8.2" r=".85"/><path class="w" d="M14.6 14.2l2 2.2"/>' },
    mysql: { name: 'MySQL', kind: 'SQL', group: 'sql', mode: 'preview', nouns: ['Table', 'Row', 'Primary key'],
      svg: '<path class="a" d="M2.6 16.2c1.9-4.8 5.8-8.6 10.8-9.7 2.7-.6 5.3-.2 7.2 1.2-.9.1-1.7.6-2.1 1.3 1.6.8 2.8 2.1 3.4 3.6-1.4-.6-3-.8-4.4-.5-3.9.8-6.8 4.1-7.8 8.4-.9-1.6-2.7-2.7-4.5-2.8-.9 0-1.8.1-2.6.5z"/><path class="a" d="M11.6 6.9c.3-1.6 1.3-2.9 2.8-3.5-.2 1-.1 2.1.3 3z"/><path class="b" d="M2.6 16.2c-.6.3-1.1.7-1.5 1.2.9-.1 1.8.1 2.5.6z"/><circle class="c" cx="17.4" cy="9.4" r=".7"/>' },
    mariadb: { name: 'MariaDB', kind: 'SQL', group: 'sql', mode: 'preview', nouns: ['Table', 'Row', 'Primary key'],
      svg: '<path class="a" d="M1.8 15.6c2.1-1.4 4.8-1.7 7.3-.9 2-4 5.5-6.9 9.8-7.8.4-1.5 1.3-2.5 2.4-3-.2.9-.1 1.9.2 2.7.6 1.5.4 3.1-.6 4.3-1.6 1.8-3.8 2.7-6.1 3-1.4 2.7-3.9 4.6-6.9 5.1-2.2.4-4.5 0-6.3-1.4-.7-.6-1.4-1.2-1.8-2z"/><circle class="c" cx="19" cy="8" r=".7"/>' },
    sqlserver: { name: 'SQL Server', kind: 'SQL', group: 'sql', mode: 'preview', nouns: ['Table', 'Row', 'Primary key'],
      svg: '<path class="b" d="M3 20.5c5.6-.4 11.4-1.9 17.6-5.6l.4.9C14.8 19.8 8.7 21.4 3 21.6z"/><path class="a" d="M3.6 18.9c2.4-6.6 7.6-12.3 15.8-15.4-2.9 3.3-4.9 7-5.9 11.1 2.1-.6 4.1-1.6 5.9-2.9-2.8 4.7-7.8 7.5-15.8 7.2z"/><path class="c" d="M8.3 15.6c2.1-3.6 4.9-6.6 8.4-8.9-1.6 2.3-2.7 4.9-3.2 7.6-1.7.6-3.4 1-5.2 1.3z"/>' },
    // Batch one: MongoDB previews inside a transaction; Redis and DynamoDB are guarded.
    mongodb: { name: 'MongoDB', kind: 'Document', group: 'one', mode: 'preview', nouns: ['Collection', 'Document', '_id'],
      svg: '<path class="a" d="M12 1.4c.6 1.5 1.4 2.5 2.5 3.7 1.9 2.1 3.7 4.4 3.7 8 0 3.9-2.3 6.4-5 7.5l-.4 2.6H12z"/><path class="b" d="M12 1.4c-.6 1.5-1.4 2.5-2.5 3.7-1.9 2.1-3.7 4.4-3.7 8 0 3.9 2.3 6.4 5 7.5l.4 2.6H12z"/><path class="c" d="M11.55 18.6h.9v4.8h-.9z"/>' },
    redis: { name: 'Redis', kind: 'Key-value', group: 'one', mode: 'guard', nouns: ['Key prefix', 'Key', 'Key'],
      svg: ['14.6', '10.6', '6.6'].map(y => { const v = +y; return `<path class="b" d="M2 ${v}v2.1l10 3.6 10-3.6V${v}l-10 3.5z"/><path class="a" d="M2 ${v}l10-3.5 10 3.5-10 3.5z"/>`; }).join('') +
        '<path class="w" d="M7.1 6.6l1.5-.95 1.5.95-1.5.95z"/><path class="b" d="M13.6 6.6l2.1-1.35 2.1 1.35-2.1 1.35z"/>' },
    dynamodb: { name: 'DynamoDB', kind: 'Key-value', group: 'one', mode: 'guard', nouns: ['Table', 'Item', 'Primary key'],
      svg: '<rect class="a" x="1.5" y="1.5" width="21" height="21" rx="4.5"/><g class="g"><ellipse cx="12" cy="7.3" rx="5" ry="1.9"/><path d="M7 7.3v9.4c0 1.05 2.24 1.9 5 1.9s5-.85 5-1.9V7.3"/><path d="M7 10.45c0 1.05 2.24 1.9 5 1.9s5-.85 5-1.9M7 13.6c0 1.05 2.24 1.9 5 1.9s5-.85 5-1.9"/></g>' },
    // Batch two: guard only.
    cassandra: { name: 'Cassandra', kind: 'Wide-column', group: 'two', mode: 'guard', nouns: ['Table', 'Row', 'Partition key'],
      svg: '<g class="g"><path d="M2.4 14c2.6-4 5.9-6.1 9.6-6.1s7 2.1 9.6 6.1c-2.6 3.7-5.9 5.6-9.6 5.6S5 17.7 2.4 14z"/><path d="M12 3v2.7M7 4.3l1.2 2.4M17 4.3l-1.2 2.4M3.3 7.2l2 1.9M20.7 7.2l-2 1.9"/></g><circle class="a" cx="12" cy="13.7" r="3.5"/><circle class="w" cx="13.15" cy="12.6" r="1.05"/>' },
    elasticsearch: { name: 'Elasticsearch', kind: 'Search', group: 'two', mode: 'guard', nouns: ['Index', 'Document', '_id'],
      svg: '<path class="a" d="M3.4 8A9.5 9.5 0 0 1 20.6 8z"/><path class="b" d="M3.4 16a9.5 9.5 0 0 0 17.2 0z"/><rect class="c" x="2" y="9.3" width="20" height="5.4" rx="2.7"/><path class="d" d="M4.7 9.3h6v5.4h-6a2.7 2.7 0 0 1 0-5.4z"/>' },
    opensearch: { name: 'OpenSearch', kind: 'Search', group: 'two', mode: 'guard', nouns: ['Index', 'Document', '_id'],
      svg: '<path class="a" d="M21.1 8.6a.95.95 0 0 0-.95.95c0 5.5-4.5 10-10 10a.95.95 0 0 0 0 1.9c6.6 0 11.9-5.3 11.9-11.9a.95.95 0 0 0-.95-.95z"/><path class="b" d="M16.4 14.2c1.1-1.8 2.2-4.1 2-7.3C18 .9 10.5-.4 6.9 4.3 5.5 6.2 5.3 9.4 9 11.4c2.1 1.1 4.6 1.6 7.4 2.8z"/><path class="a" d="M4.2 7.6C3.1 9.4 2 11.7 2.2 14.9c.4 6 7.9 7.3 11.5 2.6 1.4-1.9 1.6-5.1-2.1-7.1-2.1-1.1-4.6-1.6-7.4-2.8z"/>' },
    cosmosdb: { name: 'Cosmos DB', kind: 'Multi-model', group: 'two', mode: 'guard', nouns: ['Container', 'Item', 'id + partition key'],
      svg: '<ellipse class="r" cx="12" cy="12.6" rx="10.2" ry="3.4" transform="rotate(-24 12 12.6)"/><circle class="a" cx="12" cy="12.6" r="6.2"/><path class="b" d="M6.6 9.6a6.2 6.2 0 0 1 8.3-2.5 7.2 7.2 0 0 0-8.3 2.5z"/><path class="r" d="M18.2 9.2c2.6-.4 4.1.1 4.3 1.1.4 2-4.5 5.2-10.9 7.1"/><path class="s" d="M4.4 2.4l.7 1.6 1.6.7-1.6.7-.7 1.6-.7-1.6L2.1 4.7l1.6-.7zM19.6 18l.6 1.3 1.3.6-1.3.6-.6 1.3-.6-1.3-1.3-.6 1.3-.6z"/>' },
    firestore: { name: 'Firestore', kind: 'Document', group: 'two', mode: 'guard', nouns: ['Collection', 'Document', 'Document ID'],
      svg: '<path class="c" d="M3 16.4 12 12l9 4.4-9 4.6z"/><path class="b" d="M3 11.6 12 7.2l9 4.4-9 4.5z"/><path class="a" d="M12 2.4l9 4.4-9 4.5-9-4.5z"/>' },
    // A store without a known mark: the generic glyph, so the layout never changes.
    other: { name: 'Other store', kind: 'Unknown', group: 'other', mode: 'guard', nouns: ['Target', 'Record', 'Key'],
      svg: '<g class="g"><ellipse cx="12" cy="5.5" rx="7.5" ry="2.8"/><path d="M4.5 5.5v13c0 1.55 3.36 2.8 7.5 2.8s7.5-1.25 7.5-2.8v-13"/><path d="M4.5 12c0 1.55 3.36 2.8 7.5 2.8s7.5-1.25 7.5-2.8"/></g>' },
  };

  /** The mark as inline SVG. cls adds size classes (lg-14, lg-16, lg-20, lg-32). */
  function logo(id, cls = '') {
    const s = stores[id] || stores.other;
    return `<svg class="lg lg-${stores[id] ? id : 'other'}${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${s.svg}</svg>`;
  }

  window.SP = Object.assign(window.SP || {}, { stores, logo });
})();
