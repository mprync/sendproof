/**
 * Prisma provider behaviour against real databases: SQLite always, PostgreSQL and MySQL when
 * BENCH_POSTGRES_URL / BENCH_MYSQL_URL are set. Every Preview is checked against an independent
 * read of durable state afterwards.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaPreview } from '@sendproof/prisma';
import type { PrismaPreviewOptions } from '@sendproof/prisma';
import { capturing, sqlEntries } from './support/capture.mts';
import { targets } from './support/prisma-databases.mts';
import type { Client, TestDatabase } from './support/prisma-databases.mts';

const names = async (client: Client) =>
  (await client.item.findMany({ orderBy: { id: 'asc' } })).map((row: { id: string; name: string }) => row.id + ':' + row.name);

for (const target of targets()) {
  describe('Prisma provider on ' + target.name, () => {
    let db: TestDatabase;
    const clients: Client[] = [];

    before(async () => { db = await target.open(); });
    after(async () => {
      for (const client of clients) await client.$disconnect().catch(() => {});
      await db.cleanup();
    });

    /** A provider with automatic capture over freshly created, empty tables. */
    const provide = async (options: PrismaPreviewOptions = {}) => {
      const preview = new PrismaPreview(await db.adapter(), { models: db.models, ...options });
      preview.attach(db.client(preview.adapter));
      const client: Client = preview.client;
      clients.push(client);
      await db.reset(client);
      return { preview, client };
    };

    it('captures create, update and delete by schema keys and rolls them back', async () => {
      const { preview, client } = await provide();
      await client.item.create({ data: { id: 'a', name: 'A' } });
      const { result, captured } = await capturing(() => preview.preview(() => preview.run(async (tx: Client) => {
        await tx.item.create({ data: { id: 'b', name: 'B' } });
        await tx.item.update({ where: { id: 'a' }, data: { name: 'A2' } });
        await tx.item.delete({ where: { id: 'b' } });
        return names(tx);
      })));
      assert.deepEqual(result, ['a:A2']);
      assert.deepEqual(captured.changes, [
        { operation: 'insert', table: 'items', key: { id: 'b' }, before: null, after: { id: 'b', name: 'B' } },
        { operation: 'update', table: 'items', key: { id: 'a' }, before: { id: 'a', name: 'A' }, after: { id: 'a', name: 'A2' } },
        { operation: 'delete', table: 'items', key: { id: 'b' }, before: { id: 'b', name: 'B' }, after: null },
      ]);
      assert.notEqual(captured.changesTruncated, true);
      assert.deepEqual(await names(client), ['a:A']);
    });

    it('identifies composite keys, mapped columns and BigInt values', async () => {
      const { preview, client } = await provide();
      const { captured } = await capturing(() => preview.preview(() => preview.run(async (tx: Client) => {
        await tx.entry.create({ data: { book: 'cash', line: 1, amount: 125n } });
        await tx.entry.update({ where: { book_line: { book: 'cash', line: 1 } }, data: { amount: 150n } });
        await tx.entry.upsert({
          where: { book_line: { book: 'cash', line: 2 } },
          create: { book: 'cash', line: 2, amount: 7n }, update: { amount: 8n },
        });
      })));
      assert.deepEqual(captured.changes, [
        { operation: 'insert', table: 'entries', key: { book: 'cash', line: 1 }, before: null,
          after: { book: 'cash', line: 1, amount_minor: '125' } },
        { operation: 'update', table: 'entries', key: { book: 'cash', line: 1 },
          before: { book: 'cash', line: 1, amount_minor: '125' }, after: { book: 'cash', line: 1, amount_minor: '150' } },
        { operation: 'insert', table: 'entries', key: { book: 'cash', line: 2 }, before: null,
          after: { book: 'cash', line: 2, amount_minor: '7' } },
      ]);
      assert.equal(await client.entry.count(), 0);
    });

    it('reads generated keys from the write and keeps narrowed selections narrow', async () => {
      const { preview, client } = await provide();
      await client.item.create({ data: { id: 'a', name: 'A' } });
      const { result, captured } = await capturing(() => preview.preview(() => preview.run((tx: Client) =>
        tx.note.create({ data: { itemId: 'a', body: 'hello' }, select: { body: true } }))));
      assert.deepEqual(result, { body: 'hello' });
      assert.equal(captured.changes.length, 1);
      const [change] = captured.changes;
      assert.equal(change!.table, 'notes');
      assert.equal(change!.operation, 'insert');
      const id = (change!.key as { id: number }).id;
      assert.equal(typeof id, 'number');
      assert.deepEqual(change!.after, { id, item_id: 'a', body: 'hello' });
      assert.equal(await client.note.count(), 0);
    });

    it('captures each row of bulk writes and marks writes it cannot identify', async () => {
      const { preview, client } = await provide();
      await client.item.createMany({ data: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }] });
      const bulk = await capturing(() => preview.preview(() => preview.run(async (tx: Client) => {
        await tx.item.updateMany({ where: { id: { in: ['a', 'b'] } }, data: { name: 'Z' } });
        await tx.item.deleteMany({ where: { id: 'c' } });
        await tx.item.createMany({ data: [{ id: 'd', name: 'D' }, { id: 'e', name: 'E' }] });
      })));
      assert.deepEqual(bulk.captured.changes.map(change => change.operation + ':' + (change.key as { id: string }).id),
        ['update:a', 'update:b', 'delete:c', 'insert:d', 'insert:e']);
      assert.notEqual(bulk.captured.changesTruncated, true);

      const unknown = await capturing(() => preview.preview(() => preview.run(async (tx: Client) => {
        await tx.note.createMany({ data: [{ itemId: 'a', body: 'one' }] });
        await tx.item.create({ data: { id: 'n', name: 'N', notes: { create: { body: 'nested' } } } });
      })));
      assert.equal(unknown.captured.changesTruncated, true);
      assert.deepEqual(await names(client), ['a:A', 'b:B', 'c:C']);
      assert.equal(await client.note.count(), 0);
    });

    it('bounds the rows read for one bulk write', async () => {
      const { preview, client } = await provide({ maxTrackedRows: 2 });
      await client.item.createMany({ data: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }] });
      const { result, captured } = await capturing(() => preview.preview(() => preview.run((tx: Client) =>
        tx.item.updateMany({ data: { name: 'Z' } }))));
      assert.equal(result.count, 3);
      assert.equal(captured.changes.length, 2);
      assert.equal(captured.changesTruncated, true);
    });

    it('rolls back nested transactions that use savepoints', async () => {
      const { preview, client } = await provide();
      const { result, captured } = await capturing(() => preview.preview(() => preview.run(async (tx: Client) => {
        await tx.$transaction(async (inner: Client) => { await inner.item.create({ data: { id: 'kept', name: 'K' } }); });
        await assert.rejects(tx.$transaction(async (inner: Client) => {
          await inner.item.create({ data: { id: 'undone', name: 'U' } });
          throw new Error('inner failure');
        }), /inner failure/);
        return names(tx);
      })));
      assert.deepEqual(result, ['kept:K']);
      assert.deepEqual(captured.changes.map(change => change.operation + ':' + (change.key as { id: string }).id),
        ['insert:kept', 'insert:undone']);
      assert.deepEqual(await names(client), []);
    });

    it('rethrows a failed request only after its writes roll back', async () => {
      const { preview, client } = await provide();
      await assert.rejects(preview.preview(() => preview.run(async (tx: Client) => {
        await tx.item.create({ data: { id: 'x', name: 'X' } });
        throw new Error('handler failed');
      })), /handler failed/);
      assert.deepEqual(await names(client), []);
      assert.deepEqual(await preview.run(names), []);
    });

    it('commits and records writes in Send mode', async () => {
      const { preview, client } = await provide();
      const { captured } = await capturing(() => preview.run((tx: Client) =>
        tx.item.create({ data: { id: 's', name: 'Sent' } })), { mode: 'send' });
      assert.deepEqual(captured.changes, [
        { operation: 'insert', table: 'items', key: { id: 's' }, before: null, after: { id: 's', name: 'Sent' } },
      ]);
      assert.deepEqual(await names(client), ['s:Sent']);
    });

    it('records application SQL with redacted values and hides its own lookups', async () => {
      const { preview } = await provide();
      const placeholder = db.provider === 'postgresql' ? '$1::text' : db.placeholder(1);
      const { captured } = await capturing(() => preview.preview(async () => {
        await preview.withParameterNames(['fixture_secret'], () => preview.run((tx: Client) =>
          tx.$queryRawUnsafe(`SELECT ${placeholder} AS value`, 'fixture-secret-value')));
        await preview.run((tx: Client) => tx.item.create({ data: { id: 'q', name: 'Q' } }));
      }), { parameterValues: true });
      const entries = sqlEntries(captured);
      const secret = entries.find(entry => entry.text.includes('AS value'));
      assert.deepEqual(secret?.parameters?.map(parameter => [parameter.name, parameter.value]),
        [['fixture_secret', '[REDACTED]']]);
      assert.ok(entries.some(entry => /^INSERT INTO/i.test(entry.text.trim())));
      assert.ok(!JSON.stringify(captured).includes('fixture-secret-value'));

      // The before/after reads of automatic capture are not application SQL: the same write
      // logs exactly what a provider without capture logs.
      const plain = new PrismaPreview(await db.adapter());
      plain.attach(db.client(plain.adapter));
      clients.push(plain.client);
      if (db.provider === 'sqlite') await db.reset(plain.client);
      const create = (provider: PrismaPreview<unknown>) => capturing(() => provider.preview(() => provider.run((tx: Client) =>
        tx.item.create({ data: { id: 'p', name: 'P' } }))));
      const texts = async (provider: PrismaPreview<unknown>) => sqlEntries((await create(provider)).captured).map(entry => entry.text);
      assert.deepEqual(await texts(preview), await texts(plain));
    });

    it('blocks an early commit and rolls back earlier writes', async () => {
      const { preview, client } = await provide();
      await assert.rejects(preview.preview(() => preview.run(async (tx: Client) => {
        await tx.item.create({ data: { id: 'before-commit', name: 'Before' } });
        await tx.$executeRawUnsafe('COMMIT');
      })), /not contained|did not acknowledge/);
      assert.deepEqual(await names(client), []);
    });

    if (target.name === 'MySQL') {
      it('blocks MySQL DDL that would commit implicitly and rolls back earlier writes', async () => {
        const { preview, client } = await provide();
        await assert.rejects(preview.preview(() => preview.run(async (tx: Client) => {
          await tx.item.create({ data: { id: 'before-ddl', name: 'Before' } });
          await tx.$executeRawUnsafe('CREATE TABLE implicit_commit (id INT PRIMARY KEY)');
        })), /not contained/);
        assert.deepEqual(await names(client), []);
      });
    }

    if (target.name !== 'SQLite') {
      it('blocks root client writes during a Preview', async () => {
        const { preview, client } = await provide();
        const read = await preview.preview(() => client.item.findMany());
        assert.deepEqual(read, []);
        await assert.rejects(preview.preview(() => client.item.create({ data: { id: 'r', name: 'Root' } })),
          /not contained/);
        assert.deepEqual(await names(client), []);
      });
    } else {
      it('keeps root client writes inside the SQLite Preview transaction', async () => {
        const { preview, client } = await provide();
        const result = await preview.preview(async () => {
          await client.$executeRawUnsafe("INSERT INTO items (id, name) VALUES ('r', 'Root')");
          return names(client);
        });
        assert.deepEqual(result, ['r:Root']);
        assert.deepEqual(await names(client), []);
      });
    }
  });
}
