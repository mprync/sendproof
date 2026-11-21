import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';

const serverVariables = {
  postgresql: 'BENCH_POSTGRES_URL',
  mysql: 'BENCH_MYSQL_URL',
  sqlserver: 'BENCH_SQLSERVER_URL',
};

export const engines = new Set(['sqlite', 'h2', ...Object.keys(serverVariables)]);

async function connect(engine, url) {
  if (engine === 'postgresql') {
    const { Client } = await import('pg');
    const client = new Client({ connectionString: url.href, connectionTimeoutMillis: 5000 });
    // A reset after the query finished must not crash the runner; the next use reconnects.
    client.on('error', () => {});
    await client.connect();
    return {
      query: async sql => (await client.query(sql)).rows,
      close: () => client.end(),
    };
  }
  if (engine === 'mysql') {
    const { createConnection } = await import('mysql2/promise');
    const client = await createConnection(url.href);
    return {
      query: async sql => (await client.query(sql))[0],
      close: () => client.end(),
    };
  }

  const { Connection, Request } = await import('tedious');
  const client = new Connection({
    server: url.hostname.replace(/^\[|\]$/g, ''),
    authentication: { type: 'default', options: {
      userName: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
    } },
    options: {
      port: Number(url.port || 1433),
      database: url.pathname.slice(1) || 'master',
      encrypt: url.searchParams.get('encrypt') !== 'false',
      trustServerCertificate: url.searchParams.get('trustServerCertificate') === 'true',
      connectTimeout: 10000, requestTimeout: 10000,
    },
  });
  await new Promise((resolve, reject) => client.connect(error => error ? reject(error) : resolve()));
  return {
    query(sql) {
      return new Promise((resolve, reject) => {
        const rows = [];
        const request = new Request(sql, error => error ? reject(error) : resolve(rows));
        request.on('row', columns => rows.push(Object.fromEntries(columns.map(column => [column.metadata.colName, column.value]))));
        client.execSqlBatch(request);
      });
    },
    async close() {
      const ended = once(client, 'end');
      client.close();
      await ended;
    },
  };
}

/**
 * Connects, retrying a reset connection a few times. Docker Desktop's port proxy occasionally resets a new connection
 * right after a container starts or under heavy connection churn; that is an environment hiccup, not a test failure.
 */
async function connectWithRetry(engine, url) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await connect(engine, url);
    } catch (error) {
      if (attempt >= 10 || !/terminated|ECONNRESET|EPIPE|EADDRNOTAVAIL/i.test(error.message)) throw error;
      await new Promise(resolve => setTimeout(resolve, 500 * attempt));
    }
  }
}

async function useConnection(engine, url, run) {
  const client = await connectWithRetry(engine, url);
  try { return await run(client); } finally { await client.close(); }
}

/** Provision one database per fixture process. External services receive random database names only. */
export async function withFixtureDatabase(engine, run) {
  assert(engines.has(engine), `Unsupported conformance database: ${engine}`);
  const variable = serverVariables[engine];
  if (!variable) return run({ env: { BENCH_DATABASE: engine } });
  assert(process.env[variable], `Set ${variable} to the local conformance service for ${engine}.`);
  const server = new URL(process.env[variable]);
  const protocols = { postgresql: ['postgresql:', 'postgres:'], mysql: ['mysql:'], sqlserver: ['mssql:', 'sqlserver:'] };
  assert(protocols[engine].includes(server.protocol), `Invalid database URL protocol for ${engine}`);
  const name = 'tb_' + randomBytes(10).toString('hex');
  const target = new URL(server);
  target.pathname = '/' + name;
  await useConnection(engine, server, client => client.query('CREATE DATABASE ' + name));
  try {
    return await run({
      env: { BENCH_DATABASE: engine, BENCH_DATABASE_URL: target.href },
      async verify() {
        const rows = await useConnection(engine, target, client =>
          client.query("SELECT id, name FROM items WHERE id IN ('traced', 'preview-create', 'failed', 'oversized')"));
        assert.deepEqual(rows, [{ id: 'traced', name: 'Committed' }], `Independent ${engine} connection verifies commit and rollback`);
      },
    });
  } finally {
    await useConnection(engine, server, client =>
      client.query('DROP DATABASE ' + name + (engine === 'postgresql' ? ' WITH (FORCE)' : '')));
  }
}
