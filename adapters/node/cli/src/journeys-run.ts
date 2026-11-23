// Running a journey: one Preview session per Preview run (spec/README.md, "Preview sessions"),
// or traced Sends for a Send run, driving the journey engine (ui/journeys/, copied in at build as
// ./engine/journeys/) exactly as the workbench would. This is the one place @sendproof/cli and
// its MCP tools step through a run, so `sendproof journeys run` and the MCP run tools give the
// same results.
import { bindStep, createRun, exportRun, recordStep, skipRun, toJUnit,
  type Finding, type Json, type JsonObject, type Run, type RunContext, type RunMode, type StepResponse, type StepResult } from './engine/journeys/index.js';
import { isSafeMethod, sendPolicyProblem, SendproofError, SendproofClient, type Outcome, type RequestInput, type SendPolicy } from './client.js';
import { locateJourney, type JourneySource } from './journeys.js';
import { isJsonObject } from './openapi.js';

export { toJUnit, exportRun };
export type { Run, StepResult, RunMode };

interface RunHandle {
  run: Run;
  client: SendproofClient;
  workflow: JsonObject;
  expectations: JsonObject;
  source: JourneySource;
  sessionId?: string;
  /** Expected writes to stores this API doesn't hook, by step: reported Not checked, not Missing. */
  unchecked: Record<string, Finding[]>;
}

const runs = new Map<string, RunHandle>();

function getHandle(runId: string): RunHandle {
  const handle = runs.get(runId);
  if (!handle) throw new SendproofError(`No run “${runId}”. Start one with start_run (or sendproof journeys run).`);
  return handle;
}

/** The journey's own input defaults (the Arazzo `inputs` JSON Schema's `default` keywords, which
 *  come from the C# inputs class's property initializers, journeys.md "A journey"), so a run
 *  with no `inputs` still has sensible values; explicit `inputs` override them property by
 *  property. */
function defaultInputs(workflow: JsonObject): JsonObject {
  const properties = isJsonObject(workflow.inputs) && isJsonObject(workflow.inputs.properties) ? workflow.inputs.properties : {};
  return Object.fromEntries(Object.entries(properties)
    .filter(([, schema]) => isJsonObject(schema) && schema.default !== undefined)
    .map(([name, schema]) => [name, (schema as JsonObject).default]));
}

export interface StartRunOptions {
  journeyId: string; mode: RunMode; inputs?: JsonObject; confirmSend?: boolean;
  /** Where the request came from, so a message can name the right way to run in Send: the CLI's
   *  `--mode send` or an MCP tool's `mode: "send"` (the default). */
  surface?: 'cli' | 'mcp';
  /** Return a Send-only journey in a Preview run as a skipped run, instead of refusing it. */
  skipSendOnly?: boolean;
}

/** The expectations with the writes to stores this API doesn't hook taken out, and those writes
 *  as Not checked findings by step. A traced Send carries SQL changes and, for the other hooked
 *  stores, changes or `Db` log entries (spec/data-stores.md), which compareStep matches; a store
 *  with no hook leaves nothing to compare. */
function checkableExpectations(expectations: JsonObject, journeyId: string, caps: JsonObject, sqlSystem: string) {
  const copy: JsonObject = structuredClone(expectations);
  const unchecked: Record<string, Finding[]> = {};
  const hooked = new Set([sqlSystem, 'sql', ...(Array.isArray(caps.dataStores) ? caps.dataStores.filter(isJsonObject).map(store => String(store.system)) : [])]);
  const journeys = isJsonObject(copy.journeys) ? copy.journeys : {};
  const journey = isJsonObject(journeys[journeyId]) ? journeys[journeyId] : {};
  const steps = isJsonObject(journey.steps) ? journey.steps : {};
  for (const [stepId, expected] of Object.entries(steps)) {
    if (!isJsonObject(expected) || !Array.isArray(expected.writes)) continue;
    const kept: Json[] = [];
    expected.writes.forEach((write, index) => {
      if (!isJsonObject(write) || hooked.has(String(write.store))) { kept.push(write); return; }
      (unchecked[stepId] ??= []).push({
        id: `unchecked:${index}`, kind: 'unchecked', store: String(write.store),
        target: String(write.table ?? write.collection ?? write.key ?? ''), op: String(write.op ?? ''), fields: [],
        note: `This API doesn’t hook ${String(write.store)}, so its writes can’t be compared.`,
      });
    });
    expected.writes = kept;
  }
  return { expectations: copy, unchecked };
}

/** "Name is Send only: reason." without doubling the reason's own closing punctuation. */
function sendOnlyMessage(name: string, reason: unknown, surface: 'cli' | 'mcp'): string {
  const why = typeof reason === 'string' ? reason.trim().replace(/[\s.…]+$/, '') : '';
  return `“${name}” is Send only${why ? `: ${why}` : ''}. Run it with ${surface === 'cli' ? '--mode send' : 'mode: "send"'}.`;
}

/**
 * Starts a run: locates the journey, checks its mode is allowed (a Send-only journey can't run
 * in Preview; a Send run needs `confirmSend` and the server's `--allow-send` policy), signs in as
 * the journey's `runAs` persona when it names one (journeys.md, "Defining journeys in code") and,
 * for a Preview run, opens one Preview session that every step shares.
 */
export async function startRun(client: SendproofClient, allowSend: SendPolicy, options: StartRunOptions): Promise<Run> {
  const located = await locateJourney(client, options.journeyId);
  if (!located) throw new SendproofError(`No journey “${options.journeyId}”. Call list_journeys to see them.`);
  const { workflow, expectations, source } = located;
  const journeysMap = isJsonObject(expectations.journeys) ? expectations.journeys : {};
  const journeyExpectRaw = journeysMap[options.journeyId];
  const journeyExpect = isJsonObject(journeyExpectRaw) ? journeyExpectRaw : {};
  const caps = await client.capabilities();

  if (journeyExpect.sendOnly === true && options.mode === 'preview') {
    const message = sendOnlyMessage(String(workflow.summary ?? options.journeyId), journeyExpect.sendOnlyReason, options.surface ?? 'mcp');
    if (!options.skipSendOnly) throw new SendproofError(message);
    const skipped = createRun({ journey: workflow, expectations, mode: 'preview' });
    return skipRun(skipped, message);
  }
  if (options.mode === 'send') {
    if (!options.confirmSend) throw new SendproofError(`A Send run writes for real. Pass confirmSend: true (sendproof journeys run --yes) to send “${options.journeyId}” for real.`);
    if (allowSend === 'off') throw new SendproofError(`Send is off: start with --allow-send (allowed in Development) or --allow-send-anywhere to send “${options.journeyId}” for real, or run it with mode: "preview" instead.`);
    const problem = sendPolicyProblem(caps, allowSend);
    if (problem) throw new SendproofError(problem);
  } else if (caps.previewSessions !== true) {
    throw new SendproofError(`This API doesn’t report previewSessions: true, so journeys can’t run in Preview here. A Send-only journey can still run with ${options.surface === 'cli' ? '--mode send' : 'mode: "send"'}.`);
  }

  if (typeof journeyExpect.runAs === 'string') await client.switchPersona(journeyExpect.runAs);

  const sqlSystem = isJsonObject(caps.database) && typeof caps.database.system === 'string' ? caps.database.system : 'sqlite';
  const checkable = checkableExpectations(expectations, options.journeyId, caps, sqlSystem);
  const run = createRun({
    journey: workflow, expectations: checkable.expectations, mode: options.mode, inputs: { ...defaultInputs(workflow), ...options.inputs },
    persona: typeof journeyExpect.runAs === 'string' ? journeyExpect.runAs : undefined, store: sqlSystem,
  });
  const handle: RunHandle = { run, client, workflow, expectations, source, unchecked: checkable.unchecked };
  if (options.mode === 'preview') handle.sessionId = (await client.openSession()).id;
  runs.set(run.runId, handle);
  return run;
}

export interface RunStepOverrides { path?: JsonObject; query?: JsonObject; headers?: JsonObject; body?: Json }

/** Runs one step: the next pending step, or `stepId`. Binds its request from the run's inputs
 *  and earlier steps' outputs (`overrides` replace individual bound values), sends it as the
 *  run's mode says, and records the result (criteria, outputs, write comparison) on the run. */
export async function runStep(runId: string, stepId?: string, overrides: RunStepOverrides = {}): Promise<StepResult> {
  const handle = getHandle(runId);
  const { run, client, workflow } = handle;
  const target = stepId ? run.steps.find(step => step.stepId === stepId) : run.steps.find(step => step.status === 'pending');
  if (!target) throw new SendproofError(stepId ? `Run “${runId}” has no step “${stepId}”.` : `Run “${runId}” has no pending step: it may already be finished.`);
  if (target.status !== 'pending') throw new SendproofError(`Step “${target.stepId}” already ran (status “${target.status}”). Start a new run to redo it.`);
  const stepDef = (Array.isArray(workflow.steps) ? workflow.steps : []).find((step): step is JsonObject => isJsonObject(step) && step.stepId === target.stepId);
  if (!stepDef) throw new SendproofError(`Journey “${run.journeyId}” has no step “${target.stepId}” in its Arazzo document.`);
  const op = await client.findOperation(String(stepDef.operationId ?? ''));

  const context: RunContext = {
    inputs: run.inputs,
    steps: Object.fromEntries(run.steps.filter(step => step.status !== 'pending').map(step => [step.stepId, { outputs: step.outputs }])),
  };
  const bound = bindStep(stepDef, context);
  const mergedBody = overrides.body === undefined ? bound.body
    : isJsonObject(bound.body) && isJsonObject(overrides.body) ? { ...bound.body, ...overrides.body } : overrides.body;
  const input: RequestInput = {
    path: { ...bound.path, ...overrides.path },
    query: { ...bound.query, ...overrides.query },
    headers: Object.fromEntries(Object.entries({ ...bound.headers, ...overrides.headers }).map(([name, value]) => [name, String(value)])),
    body: mergedBody,
  };

  const outcome: Outcome = run.mode === 'preview'
    ? await client.preview(op, input, { sessionId: handle.sessionId })
    : await client.send(op, input, { trace: true });

  const response: StepResponse = {
    statusCode: outcome.status, headers: outcome.headers, body: outcome.body,
    request: { url: op.path, method: op.method, path: input.path, query: input.query, headers: input.headers, body: input.body },
  };
  const envelope: JsonObject = { changes: outcome.changes ?? [], effects: outcome.effects ?? [], logs: outcome.logs ?? [], blocked: outcome.blocked ? { ...outcome.blocked } : undefined };
  const recorded = recordStep(run, target.stepId, { response, envelope, durationMs: outcome.durationMs });
  recorded.findings.push(...(handle.unchecked[target.stepId] ?? []));
  return recorded;
}

/** Runs every pending step in order, stopping where the run itself stops (journeys.md, "Running a
 *  journey": a refused, criteria-failing or blocked step). Returns the run once nothing is pending
 *  or it has stopped. */
export async function runRemaining(runId: string): Promise<Run> {
  const handle = getHandle(runId);
  while (handle.run.status === 'running') {
    const next = handle.run.steps.find(step => step.status === 'pending');
    if (!next) break;
    await runStep(runId, next.stepId);
  }
  return handle.run;
}

export function getRun(runId: string): Run {
  return exportRun(getHandle(runId).run);
}

/** Ends a run: rolls back and deletes its Preview session (idempotent; a Send run has none), and
 *  marks it stopped if it was still running. Ending an unknown or already-ended run is a no-op. */
export async function endRun(runId: string): Promise<void> {
  const handle = runs.get(runId);
  if (!handle) return;
  runs.delete(runId);
  if (handle.sessionId) await handle.client.deleteSession(handle.sessionId).catch(() => {});
  if (handle.run.status === 'running') {
    handle.run.status = 'stopped';
    handle.run.finishedAt = new Date().toISOString();
    handle.run.durationMs = new Date(handle.run.finishedAt).getTime() - new Date(handle.run.startedAt).getTime();
  }
}

/** Ends every open run: called when the MCP server shuts down, so no Preview session outlives
 *  the process that opened it. */
export async function endAllRuns(): Promise<void> {
  await Promise.all([...runs.keys()].map(id => endRun(id)));
}

export interface DraftApprovedDifferenceOptions { runId: string; stepId: string; findingId: string; reason: string }

interface DraftedRecord { kind: 'value' | 'missing' | 'extra'; field?: string; expected?: Json; actual?: Json }

function csharpType(value: Json | undefined): string {
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'decimal';
  if (value === undefined) return 'object';
  return 'string';
}

function csharpLiteral(value: Json | undefined): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

function renderRecord(id: string, draft: DraftedRecord, options: { reason: string; approvedBy: string; today: string }): { code: string; json: JsonObject } {
  const type = draft.kind === 'value' ? csharpType(draft.actual) : 'object';
  const [y, m, d] = options.today.split('-').map(Number);
  const fields = [
    `Id = "${id}",`,
    draft.kind === 'value' ? `Actual = ${csharpLiteral(draft.actual)},` : undefined,
    `Reason = ${csharpLiteral(options.reason)},`,
    `ApprovedBy = ${csharpLiteral(options.approvedBy)},`,
    `ApprovedOn = new DateOnly(${y}, ${m}, ${d}),`,
    `Link = null, // fill in, or remove`,
  ].filter((line): line is string => line !== undefined);
  const code = `// Name this, pass it to the Set(...) call it relaxes, and commit it: the approval is the code review.\n`
    + `public static readonly ApprovedDifference<${type}> Draft = new()\n{\n    ${fields.join('\n    ')}\n};`;
  const json: JsonObject = {
    id, journey: '', step: '', target: draft.field ? { field: draft.field } : {}, kind: draft.kind,
    ...(draft.kind === 'value' ? { expected: draft.expected, actual: draft.actual } : {}),
    reason: options.reason, approvedBy: options.approvedBy, approvedOn: options.today,
  };
  return { code, json };
}

/** Drafts one or more approved-difference records for a finding (journeys.md, "Approved
 *  differences"): one per field that differs, or one for a whole missing/extra write. Never
 *  writes a file; the author pastes and commits the C# (code journeys) or JSON (file journeys). */
export async function draftApprovedDifference(options: DraftApprovedDifferenceOptions) {
  const handle = getHandle(options.runId);
  const step = handle.run.steps.find(s => s.stepId === options.stepId);
  if (!step) throw new SendproofError(`Run “${options.runId}” has no step “${options.stepId}”.`);
  const finding = step.findings.find(f => f.id === options.findingId);
  if (!finding) throw new SendproofError(`Step “${options.stepId}” has no finding “${options.findingId}”. Its findings: ${step.findings.map(f => f.id).join(', ') || '(none)'}.`);
  if (finding.kind === 'match') throw new SendproofError(`Finding “${options.findingId}” already matches; there’s nothing to approve.`);
  if (finding.kind === 'approved') throw new SendproofError(`Finding “${options.findingId}” is already covered by an approved difference.`);

  const caps = await handle.client.capabilities();
  const identity = isJsonObject(caps.identity) ? caps.identity : undefined;
  const approvedBy = typeof identity?.email === 'string' ? identity.email : typeof identity?.name === 'string' ? String(identity.name) : '<approvedBy>';
  const today = new Date().toISOString().slice(0, 10);
  const existing = Array.isArray(handle.expectations.approvedDifferences) ? handle.expectations.approvedDifferences.filter(isJsonObject) : [];
  const nextNumber = 1 + existing.reduce((max, record) => Math.max(max, Number(/^AD-(\d+)$/.exec(String(record.id))?.[1] ?? 0)), 0);

  const drafts: DraftedRecord[] = finding.kind === 'differs'
    ? finding.fields.filter(field => field.state === 'differs').map(field => ({ kind: 'value' as const, field: field.name, expected: field.expected, actual: field.actual }))
    : [{ kind: finding.kind as 'missing' | 'extra' }];
  if (!drafts.length) throw new SendproofError(`Finding “${options.findingId}” has nothing differing to draft a record for.`);

  const records = drafts.map((draft, index) => {
    const id = `AD-${String(nextNumber + index).padStart(4, '0')}`;
    const { code, json } = renderRecord(id, draft, { reason: options.reason, approvedBy, today });
    return {
      id, kind: draft.kind, target: { store: finding.store, table: finding.target, field: draft.field },
      journey: handle.run.journeyId, step: options.stepId,
      ...(handle.source.source === 'file' ? { json: { ...json, journey: handle.run.journeyId, step: options.stepId } } : { code }),
    };
  });
  return { source: handle.source.source, findingId: options.findingId, records };
}
