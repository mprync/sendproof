// Types for the journey engine (docs/plans/journeys-build.md, Contract 3): plain, untyped ES
// modules shared with the browser, copied here at build by tools/pack-journeys-engine.mjs
// (npm run pack-engine). This file is never emitted; it only lets this package's TypeScript see
// the engine's shapes. Keep it in step with ui/journeys/index.js's exports.

export type Json = null | boolean | number | string | Json[] | JsonObject;
export type JsonObject = { [key: string]: Json | undefined };

export interface Message {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  query?: JsonObject;
  path?: JsonObject;
  body?: Json;
}

export interface StepResponse extends Message {
  statusCode?: number;
  request?: Message;
}

export interface RunContext {
  inputs?: JsonObject;
  steps?: Record<string, { outputs?: JsonObject }>;
  workflows?: JsonObject;
  request?: Message;
  response?: StepResponse;
}

export function evaluate(expression: Json, context?: RunContext): Json;
export function interpolate(value: Json, context?: RunContext): Json;

export interface Bound {
  target: string;
  expression: string;
  value: Json;
  from: 'input' | 'step' | 'fixed';
  stepId?: string;
}

export interface BoundStep {
  path: JsonObject;
  query: JsonObject;
  headers: JsonObject;
  body: Json;
  bound: Bound[];
}

export function bindStep(step: JsonObject, context?: RunContext): BoundStep;

export interface Criterion {
  condition: string;
  passed: boolean;
  actual: Json;
}

export function checkCriteria(criteria: JsonObject[] | undefined, response: StepResponse | undefined): Criterion[];
export function stepOutputs(step: JsonObject, response: StepResponse | undefined): JsonObject;

export interface FindingField {
  name: string;
  state: 'match' | 'differs' | 'approved';
  expected: Json;
  actual: Json;
  source: string;
  record?: string;
}

export interface Finding {
  id: string;
  kind: 'match' | 'differs' | 'missing' | 'extra' | 'approved' | 'unchecked';
  store?: string;
  target?: string;
  op?: string;
  key?: JsonObject;
  fields: FindingField[];
  record?: string;
  /** Set on an `unchecked` finding: why it couldn't be compared. */
  note?: string;
  /** Set on a `match` found in the step's `Db` log entries rather than its changes. */
  via?: 'log';
}

export type Verdict = 'passed' | 'passed-approved' | 'failed';

export interface CompareResult {
  verdict: Verdict;
  findings: Finding[];
}

export function compareStep(options: {
  expected?: JsonObject;
  changes?: JsonObject[];
  effects?: JsonObject[];
  logs?: JsonObject[];
  context?: RunContext;
  approved?: JsonObject[];
  ignore?: JsonObject[];
  unlisted?: 'fail' | string;
  store?: string;
  clock?: () => Date;
}): CompareResult;

export type StepStatus = 'pending' | 'passed' | 'failed' | 'refused' | 'blocked' | 'skipped';
export type RunStatus = 'running' | 'passed' | 'failed' | 'stopped' | 'skipped';
export type RunMode = 'preview' | 'send';

export interface StepResult {
  stepId: string;
  operationId: Json;
  status: StepStatus;
  httpStatus: number | null;
  durationMs: number | null;
  startMs: number | null;
  criteria: Criterion[];
  outputs: JsonObject;
  findings: Finding[];
  verdict: Verdict | null;
  bound: Bound[] | null;
}

export interface Run {
  runId: string;
  journeyId: string;
  name: string;
  mode: RunMode;
  status: RunStatus;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  persona?: string;
  inputs: JsonObject;
  steps: StepResult[];
  approvedUsed: string[];
  approvedUnused: string[];
  approvedExpired: string[];
  /** Why a `skipped` run never started. */
  skipReason?: string;
}

export function createRun(options: {
  journey: JsonObject;
  expectations: JsonObject;
  mode?: RunMode;
  inputs?: JsonObject;
  persona?: string;
  store?: string;
  clock?: () => Date;
}): Run;

export function recordStep(run: Run, stepId: string, outcome: { response?: StepResponse; envelope?: JsonObject; durationMs?: number }): StepResult;

export function skipRun(run: Run, reason: string): Run;
export function exportRun(run: Run): Run;
export function toJUnit(run: Run): string;
