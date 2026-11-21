export interface BenchIdentity {
  name?: string | null;
  role?: string;
  /** Stable authenticated subject, required for observed Send. */
  subject?: string;
  /** Authentication scheme; part of the trace owner. */
  scheme?: string;
  /** Token issuer, when subjects are only unique per issuer; part of the trace owner. */
  issuer?: string;
}

export interface BenchRequest<Raw = unknown> {
  method: string;
  pathname: string;
  query?: string;
  basePath?: string;
  origin: string;
  headers: Record<string, string | string[] | undefined>;
  raw: Raw;
}

export interface AuthProvider {
  kind: string;
  label: string;
  url: string | null;
}

export interface PreviewProvider {
  /** Run dispatch in the enrolled transaction and resolve only after rollback. */
  preview<T>(dispatch: () => Promise<T>): Promise<T>;
  /**
   * The SQL provider id discovery reports as `database.system`: `sqlite`, `postgresql`, `mysql`,
   * `mariadb`, `mssql` or another lower-case id, so the workbench shows that provider's mark.
   */
  readonly system?: string;
}

/** The binding serving the workbench, reported as capabilities `binding`. */
export interface BenchBinding {
  language: 'node';
  /** The web framework's display name: `Express`, `Fastify`, `Hono` or `NestJS`. */
  framework: string;
}

/** How Preview treats a data store: rolled back with its transaction, or guarded so writes block. */
export type DataStoreMode = 'preview' | 'guard';

/** One entry of capabilities `dataStores`. `name` is a display label, never a connection string. */
export interface DataStoreDescription {
  system: string;
  name?: string;
  mode: DataStoreMode;
  /** Why a store that might roll back runs in `guard` mode, such as a standalone MongoDB server. */
  reason?: string;
}

/**
 * A hooked data store, as returned by `redisStore`, `dynamoStore`, `mongoStore` and
 * `mongooseStore`. The core advertises it in discovery and calls it around every Preview.
 */
export interface DataStore {
  /** Store id: `mongodb`, `redis` or `dynamodb`. */
  readonly system: string;
  /** Describe the store for discovery. May detect the server topology on first call. */
  describe(): Promise<DataStoreDescription>;
  /** Wrap a Preview's dispatch, for example to make the Preview session ambient for an ORM. */
  around?<T>(capture: CaptureRecorder, dispatch: () => Promise<T>): Promise<T>;
  /**
   * Called once after the handler of every Preview, before the SQL rollback: capture changes and
   * abort the store transaction. A rejection means the abort may not have happened, and the
   * Preview answers 500 without confirmation.
   */
  finishPreview?(capture: CaptureRecorder): Promise<void>;
}

/** The first write the guard refused during a Preview. */
export interface BlockedWrite {
  /** Store id, such as `redis`. */
  store: string;
  /** The refused command or action name, never its arguments. */
  operation: string;
  /** The sentence the UI shows: "Preview unavailable: …". */
  detail: string;
}

/** An operation marked `preview: false`, listed in capabilities `previewUnavailable`. */
export interface UnavailableOperation {
  method: string;
  path: string;
  reason: string;
  stores?: string[];
}

/** Options for marking an operation `preview: false`. Give a reason, the stores it writes, or both. */
export interface UnavailableOptions {
  /** The sentence the UI shows. Defaults to "Preview unavailable: this operation writes to <first store>". */
  reason?: string;
  /** Store ids the operation writes, such as `['redis']`. */
  stores?: string[];
}

export interface BenchOptions<Raw = unknown> {
  apiName?: string;
  environment?: string;
  environments?: string[];
  openApiUrl?: string;
  documents?: { name: string; url: string }[];
  fieldModules?: string[];
  /** Display name of the database, such as `PostgreSQL`. Connection strings, URLs and paths are rejected. */
  database?: string | null;
  authProviders?: AuthProvider[];
  resolveIdentity?: (request: BenchRequest<Raw>) => BenchIdentity | null | Promise<BenchIdentity | null>;
  discoverAuth?: (request: BenchRequest<Raw>) => AuthProvider[] | Promise<AuthProvider[]>;
  authorize?: (request: BenchRequest<Raw>, identity: BenchIdentity | null) => boolean | Promise<boolean>;
  /**
   * Rolls back the SQL database around each Preview. Optional when `dataStores` is given: an app
   * whose only database is MongoDB, or that has only guarded stores, previews without one. A SQL
   * database the binding has no provider for is then not covered, like any unhooked client.
   */
  previewProvider?: PreviewProvider;
  captureLimits?: Partial<Record<'effects' | 'logs' | 'changes' | 'bytes' | 'valueBytes', number>>;
  maxResponseBytes?: number;
  traceTtlMs?: number;
  /** Monotonic time in milliseconds. */
  traceClock?: () => number;
  includeSqlParameterValues?: boolean;
  /**
   * Data stores hooked with `redisStore`, `dynamoStore`, `mongoStore` or `mongooseStore`. Writes to
   * a guarded store block a Preview; a MongoDB replica set joins it and rolls back. Clients the
   * binding never saw are not covered.
   */
  dataStores?: DataStore[];
  onError?: (error: unknown, request: BenchRequest<Raw>) => void;
}

export interface Change {
  operation: string;
  /** SQL table, MongoDB collection, DynamoDB table, or Redis key prefix. */
  table: string;
  key: unknown;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  /** Data store id; absent for the SQL database. */
  store?: string;
  /** Database that holds the collection or table. */
  namespace?: string;
  /** How a store change was made, when it was an upsert or a whole-document replacement. */
  via?: 'upsert' | 'replace';
}

export interface Effect {
  kind: string;
  description: string;
  data?: unknown;
  delivered?: boolean;
}

export interface Log {
  level: string;
  message: string;
  category?: string;
  eventId?: { id: number; name?: string };
  properties?: Record<string, string>;
  exception?: { type: string; message: string };
}

export interface SqlEntry {
  text: string;
  parameters?: { name: string; value: unknown; dbType: string }[];
  rowsAffected?: number | bigint;
  elapsedMs?: number;
}

/** A command to a non-SQL store, recorded as a log entry with level `Db`. */
export interface DbEntry {
  /** Store id, as in capabilities `dataStores`. */
  system: string;
  /** Command or action name: `find`, `INCR`, `PutItem`. */
  operation: string;
  /** Collection or table; for Redis, the first key. */
  target?: string;
  /** MongoDB database or Redis database number. */
  namespace?: string;
  /** Sanitized command text with every literal value replaced. */
  statement?: string;
  /** Documents or items matched, modified or returned. */
  rowsAffected?: number;
  /** Set on the entry for a command the guard refused. */
  blocked?: boolean;
  /** The store's error code name, such as `WriteConflict`. */
  error?: string;
  elapsedMs?: number;
}

export interface CaptureRecorder {
  readonly mode: 'preview' | 'send';
  /** False once the request finished; a store hook still refuses writes for a finished Preview. */
  readonly active: boolean;
  /** The first write the guard refused, which turns the Preview into a 409. */
  readonly blocked: BlockedWrite | null;
  /** A transaction-control refusal or escaped write, which turns the Preview into a 500. */
  readonly fault: Error | null;
  /** Record the first refused write. Later calls keep the first. */
  block(blocked: BlockedWrite): void;
  /** Record a fault that withholds confirmation. Later calls keep the first. */
  refuse(fault: Error): void;
  /** Record a command to a non-SQL store. */
  db(entry: DbEntry): void;
  change(change: Change): void;
  truncate(kind: 'changes' | 'effects' | 'logs'): void;
  effect(effect: Effect): void;
  log(log: Log): void;
  sql(entry: SqlEntry): void;
}

export interface TransportResponse {
  status: number;
  body: Buffer;
  headers: Record<string, string | number | string[] | undefined>;
  exceeded?: boolean;
}

export type CaptureCollection = 'changes' | 'effects' | 'logs';
export type CaptureLimits = NonNullable<BenchOptions['captureLimits']>;
export type CaptureMode = CaptureRecorder['mode'];

export interface SqlLog {
  text: string;
  parameters: { name: string; value: string | null; dbType: string }[];
  rowsAffected?: number;
}

export interface RecordedLog extends Log {
  elapsedMs?: number;
  offsetMs?: number;
  sql?: SqlLog;
  db?: Omit<DbEntry, 'elapsedMs'>;
}

export interface CaptureSnapshot {
  changes: Change[];
  effects: Effect[];
  logs: RecordedLog[];
  changesTruncated?: boolean;
  effectsTruncated?: boolean;
  logsTruncated?: boolean;
}

export interface Timing {
  auth: number;
  handler: number;
  db: number;
  queryCount: number;
  serialize: number;
}

export interface Trace extends CaptureSnapshot {
  timing: Timing;
}

export interface Observation {
  run<T>(callback: () => T): T;
  complete(status: number): string | undefined;
}

export type DispatchResponse = TransportResponse | { unmatched: true };
export type LookupResponse = TransportResponse | { target: string } | null;
export interface PreviewOperation { method: string; path: string; }

/** An operation a framework package registered: previewable, or marked `preview: false`. */
export type RegisteredOperation = PreviewOperation | (UnavailableOperation & { preview: false });
