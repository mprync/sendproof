// Compiled under strict settings by typeorm-types.test.mjs; never executed.
import type { PreviewProvider } from '@test-bench/core';
import { TypeOrmPreview, type TypeOrmPreviewOptions } from '@test-bench/typeorm';
import type { DataSource, EntityManager } from 'typeorm';

declare const source: DataSource;
declare class Item { id: string; name: string }

const options: TypeOrmPreviewOptions = { maxTrackedRows: 100 };
const provider = new TypeOrmPreview(source, options);
const asProvider: PreviewProvider = provider;

const found: Promise<Item | null> = provider.run(manager => manager.getRepository(Item).findOneBy({ id: 'a' }));
const manager: Promise<EntityManager> = provider.run(m => m);
const labelled: Promise<number> = provider.withParameterNames(['id'], () => 1);
const previewed: Promise<string> = provider.preview(async () => 'response');
provider.dispose();

// The deprecated key-based form still type checks, and keys now match the entity's properties.
const tracked: Promise<number | undefined> = provider.track(Item, [{ id: 'a' }], repository => repository.count().then(() => 1));

// @ts-expect-error maxTrackedRows is a number
new TypeOrmPreview(source, { maxTrackedRows: 'many' });
// @ts-expect-error preview needs an async dispatch callback
provider.preview('response');
// @ts-expect-error a DataSource is required
new TypeOrmPreview();
// @ts-expect-error track keys must name properties of the entity
provider.track(Item, [{ missing: 1 }], repository => repository.count());

export { asProvider, found, manager, labelled, previewed, tracked };
