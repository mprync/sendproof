/**
 * Model metadata used to identify changed rows. It is produced from Prisma's DMMF, either by
 * the bundled `sendproof-prisma-generator` or from a `Prisma.dmmf` document exported by the
 * `prisma-client-js` generator, so applications never list primary keys by hand.
 */

/** Row identity and column mapping for one Prisma model. */
export interface PrismaModelKeys {
  /** Database table name (`@@map`), qualified with the schema when one is declared. */
  table: string;
  /** Prisma field names that identify a row: the primary key, or the first unique criterion. */
  key: string[];
  /** Scalar Prisma field names mapped to database column names (`@map`). */
  columns: Record<string, string>;
  /** Relation field names, used to recognise nested writes. */
  relations: string[];
}

/** Metadata written by `sendproof-prisma-generator`. */
export interface PrismaModelMetadata {
  version: 1;
  models: Record<string, PrismaModelKeys>;
}

/** The subset of a Prisma DMMF model this package reads. */
export interface DmmfModel {
  name: string;
  dbName?: string | null;
  schema?: string | null;
  fields: readonly {
    name: string;
    kind: string;
    dbName?: string | null;
    isId?: boolean;
  }[];
  primaryKey?: { fields: readonly string[] } | null;
  uniqueFields?: readonly (readonly string[])[];
}

/** A DMMF document, such as `Prisma.dmmf` from the `prisma-client-js` generator. */
export interface DmmfDocument {
  datamodel: { models: readonly DmmfModel[] };
}

/** Metadata accepted by `PrismaPreview`: generated metadata or a DMMF document. */
export type PrismaModels = PrismaModelMetadata | DmmfDocument;

/** Convert DMMF models into row identity metadata. */
export function fromDmmf(models: readonly DmmfModel[]): PrismaModelMetadata {
  const result: Record<string, PrismaModelKeys> = {};
  for (const model of models) {
    const scalars = model.fields.filter(field => field.kind === 'scalar' || field.kind === 'enum');
    const key = model.primaryKey?.fields.length
      ? [...model.primaryKey.fields]
      : scalars.filter(field => field.isId).map(field => field.name);
    const unique = key.length ? key : [...(model.uniqueFields?.[0] ?? [])];
    if (!unique.length) throw new Error(`Prisma model ${model.name} has no primary key or unique fields.`);
    const table = model.dbName ?? model.name;
    result[model.name] = {
      table: model.schema ? model.schema + '.' + table : table,
      key: unique,
      columns: Object.fromEntries(scalars.map(field => [field.name, field.dbName ?? field.name])),
      relations: model.fields.filter(field => field.kind === 'object').map(field => field.name),
    };
  }
  return { version: 1, models: result };
}

/** Accept generated metadata or a DMMF document and validate its shape. */
export function normalizeModels(models: PrismaModels): PrismaModelMetadata {
  if ('datamodel' in models) return fromDmmf(models.datamodel.models);
  if (models.version !== 1 || typeof models.models !== 'object' || models.models === null) {
    throw new TypeError('Unsupported Prisma model metadata. Regenerate it with sendproof-prisma-generator.');
  }
  for (const [name, model] of Object.entries(models.models)) {
    if (!Array.isArray(model.key) || !model.key.length || model.key.some(field => !(field in model.columns))) {
      throw new TypeError(`Prisma model metadata for ${name} has no usable key.`);
    }
  }
  return models;
}

/** The client property for a model: Prisma lowercases the first character. */
export function delegateName(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1);
}
