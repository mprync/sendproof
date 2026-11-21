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
  previewProvider?: PreviewProvider;
  captureLimits?: Partial<Record<'effects' | 'logs' | 'changes' | 'bytes' | 'valueBytes', number>>;
  maxResponseBytes?: number;
  traceTtlMs?: number;
  /** Monotonic time in milliseconds. */
  traceClock?: () => number;
  includeSqlParameterValues?: boolean;
  onError?: (error: unknown, request: BenchRequest<Raw>) => void;
}

export interface Change {
  operation: string;
  table: string;
  key: unknown;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
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

export interface CaptureRecorder {
  readonly mode: 'preview' | 'send';
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
