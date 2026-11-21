/**
 * Write classification for the batch-one data stores, driven by the shared tables in
 * spec/data-stores/ (embedded in ./tables.ts). Each table lists reads and connection-level
 * commands; everything else, including a command the table has never heard of, is a write, so the
 * guard fails closed when a store adds a command.
 *
 * Every function here is pure. The shared vectors in spec/data-stores/classification-cases.json
 * run through them in tests/stores-core.test.mjs.
 */
import { dynamodbTable, mongodbTable, redisTable } from './tables.js';

/** How the guard treats one store command. Only `write` can block a Preview. */
export type CommandKind = 'read' | 'write' | 'session' | 'transaction';

/** The result of classifying a MongoDB command document. */
export interface MongoClassification {
  kind: Exclude<CommandKind, 'transaction'>;
  /** The command or aggregation stage MongoDB refuses inside a transaction, such as `$out`. */
  refusedInTransaction?: string;
}

const redis = {
  read: new Set<string>([...redisTable.read, ...redisTable.moduleRead]),
  session: new Set<string>(redisTable.session),
  transaction: new Set<string>(redisTable.transaction),
};
const mongo = {
  read: new Set<string>(mongodbTable.read.map(name => name.toLowerCase())),
  session: new Set<string>(mongodbTable.session.map(name => name.toLowerCase())),
  notInTransaction: new Set<string>(mongodbTable.notInTransaction.commands.map(name => name.toLowerCase())),
  stages: mongodbTable.notInTransaction.stages as readonly string[],
};
const dynamo = { read: new Set<string>(dynamodbTable.read), partiql: new Set<string>(dynamodbTable.partiql.operations) };
const writingStages = new Set(['$out', '$merge']);

/**
 * Classify a Redis command. `name` is the command name in any case and `args` its arguments, of
 * which only the first is read, to form `CONTAINER|SUBCOMMAND` keys such as `OBJECT|ENCODING`.
 * `treatAsRead` holds host-declared reads, compared exactly against the upper-case key.
 */
export function classifyRedis(name: string, args: readonly unknown[] = [], treatAsRead?: ReadonlySet<string>): CommandKind {
  const command = String(name).toUpperCase();
  const first = args[0];
  const withSub = first === undefined ? command : `${command}|${(Buffer.isBuffer(first) ? first.toString() : String(first)).toUpperCase()}`;
  for (const key of [withSub, command]) {
    if (redis.session.has(key)) return 'session';
    if (redis.transaction.has(key)) return 'transaction';
    if (redis.read.has(key) || treatAsRead?.has(key)) return 'read';
  }
  return 'write';
}

/** A plain object literal, as opposed to BSON values, arrays and class instances. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Whether any key of an aggregation pipeline, at any depth (sub-pipelines included), is in `stages`. */
function pipelineUses(value: unknown, stages: ReadonlySet<string>): boolean {
  if (Array.isArray(value)) return value.some(item => pipelineUses(item, stages));
  if (isPlainObject(value)) return Object.entries(value).some(([key, inner]) => stages.has(key) || pipelineUses(inner, stages));
  return false;
}

/**
 * Classify a MongoDB command document by its first key, case-insensitively. `aggregate` is a write
 * when any stage at any depth is `$out` or `$merge`; `explain` takes the classification of the
 * command inside it. `refusedInTransaction` names what a `preview`-mode Preview must block first.
 * `treatAsRead` holds host-declared reads in lower case.
 */
export function classifyMongo(command: Record<string, unknown>, treatAsRead?: ReadonlySet<string>): MongoClassification {
  const name = Object.keys(command)[0] ?? '';
  const lower = name.toLowerCase();
  if (lower === 'explain' && isPlainObject(command[name])) return classifyMongo(command[name], treatAsRead);
  let refused: string | undefined;
  if (mongo.notInTransaction.has(lower)) refused = name;
  if (lower === 'aggregate') refused = mongo.stages.find(stage => pipelineUses(command.pipeline, new Set([stage]))) ?? refused;
  const withRefusal = <T extends MongoClassification>(result: T): T => refused === undefined ? result : { ...result, refusedInTransaction: refused };
  if (mongo.session.has(lower)) return { kind: 'session' };
  if (lower === 'aggregate' && pipelineUses(command.pipeline, writingStages)) return withRefusal({ kind: 'write' });
  if (mongo.read.has(lower) || treatAsRead?.has(lower)) return withRefusal({ kind: 'read' });
  return withRefusal({ kind: 'write' });
}

/** Skip whitespace and SQL-style comments, then return the first word of a PartiQL statement in upper case. */
export function partiqlVerb(statement: unknown): string {
  let text = String(statement ?? '');
  for (;;) {
    const trimmed = text.replace(/^\s+/, '');
    if (trimmed.startsWith('--')) {
      const end = trimmed.indexOf('\n');
      text = end < 0 ? '' : trimmed.slice(end + 1);
      continue;
    }
    if (trimmed.startsWith('/*')) {
      const end = trimmed.indexOf('*/');
      if (end < 0) return '';
      text = trimmed.slice(end + 2);
      continue;
    }
    return (/^[A-Za-z]+/.exec(trimmed)?.[0] ?? '').toUpperCase();
  }
}

/**
 * Classify a DynamoDB action and its input as `read` or `write`. A PartiQL request is a read only
 * when every statement in it is a `SELECT`. `treatAsRead` holds host-declared action names.
 */
export function classifyDynamo(operation: string, input: Record<string, unknown> = {}, treatAsRead?: ReadonlySet<string>): 'read' | 'write' {
  if (dynamo.read.has(operation) || treatAsRead?.has(operation)) return 'read';
  if (dynamo.partiql.has(operation)) {
    const list = (input.Statements ?? input.TransactStatements) as { Statement?: unknown }[] | undefined;
    const statements = operation === 'ExecuteStatement' ? [input.Statement] : Array.isArray(list) ? list.map(item => item?.Statement) : [];
    return statements.length > 0 && statements.every(statement => partiqlVerb(statement) === 'SELECT') ? 'read' : 'write';
  }
  return 'write';
}
