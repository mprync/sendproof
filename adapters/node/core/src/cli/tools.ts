// The MCP tools: everything the workbench does, for an agent. Each tool has an input schema and an
// output schema, returns structured content with a one-line summary, and reports a problem the
// agent can act on (a missing parameter, a refused Send) as a tool error rather than a crash.

import { isSafeMethod, sendPolicyProblem, SendproofClient, SendproofError, type Outcome, type RequestInput, type SendPolicy } from './client.js';
import { describeJourney, journeySources, listJourneys } from './journeys.js';
import { draftApprovedDifference, endRun, exportRun, getRun, runRemaining, runStep, startRun } from './journeys-run.js';
import { compactSchema, dereference, isJsonObject, refName, requestBody, responses, schemaAt, type Json, type JsonObject } from './openapi.js';

export type { SendPolicy };

export interface ToolContext {
  client: SendproofClient;
  allowSend: SendPolicy;
  /** Called when the set of tools may have changed (after a persona switch or a refresh). */
  toolsChanged?: () => void;
}

export interface ToolResult { summary: string; data: JsonObject }

interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonObject;
  outputSchema: JsonObject;
  annotations: JsonObject;
  /** Listed only when this returns true for the API's capabilities. */
  available?: (caps: JsonObject, context: ToolContext) => boolean;
  run: (args: JsonObject, context: ToolContext) => Promise<ToolResult>;
}

/** An error the agent caused and can fix; reported as `isError: true` with this message. */
export class ToolInputError extends Error {}

const BODY_LIMIT = 48_000;
const LOG_LIMIT = 60;

const obj = (properties: JsonObject, required: string[] = []): JsonObject => ({ type: 'object', properties, required, additionalProperties: false });
const open = (properties: JsonObject = {}): JsonObject => ({ type: 'object', properties, additionalProperties: true });
const str = (description: string): JsonObject => ({ type: 'string', description });
const anyJson: JsonObject = {};

const requestProperties: JsonObject = {
  operationId: str('The operation’s operationId, or "METHOD /path", from list_operations.'),
  path: { type: 'object', description: 'Path parameters by name, such as { "id": "5e3a…" }.', additionalProperties: true },
  query: { type: 'object', description: 'Query parameters by name. Arrays and objects follow the parameter’s style.', additionalProperties: true },
  headers: { type: 'object', description: 'Request headers by name (header parameters and anything else to send).', additionalProperties: { type: 'string' } },
  body: { description: 'The request body as JSON (or a string for text bodies).' },
  contentType: str('The body’s media type, when the operation accepts more than one. Defaults to its JSON type.'),
  logs: { type: 'string', enum: ['none', 'summary', 'all'], description: 'How much of the captured log to return. summary (default) leaves out Debug and Trace entries and keeps the first 60.' },
};

const outcomeSchema = open({
  status: { type: 'integer' }, headers: { type: 'object' }, body: anyJson, durationMs: { type: 'integer' },
  rolledBack: { type: 'boolean' }, blocked: open(), changes: { type: 'array' }, effects: { type: 'array' }, logs: { type: 'array' },
});

function text(value: Json | undefined, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new ToolInputError(`${name} must be a string.`);
  return value;
}

function required(args: JsonObject, name: string): string {
  const value = text(args[name], name)?.trim();
  if (!value) throw new ToolInputError(`${name} is required.`);
  return value;
}

function record(value: Json | undefined, name: string): JsonObject | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isJsonObject(value)) throw new ToolInputError(`${name} must be an object of names to values.`);
  return value;
}

function requestInput(args: JsonObject): RequestInput {
  const headers = record(args.headers, 'headers');
  return {
    path: record(args.path, 'path'),
    query: record(args.query, 'query'),
    headers: headers && Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, String(v)])),
    body: args.body === undefined ? undefined : args.body,
    contentType: text(args.contentType, 'contentType'),
  };
}

/** Large bodies are cut, with a note, so one response can't flood the agent's context. */
function boundedBody(body: Json): { body: Json; bodyTruncated?: boolean } {
  const serialised = typeof body === 'string' ? body : JSON.stringify(body);
  if ((serialised ?? '').length <= BODY_LIMIT) return { body };
  return { body: serialised.slice(0, BODY_LIMIT), bodyTruncated: true };
}

function boundedLogs(logs: Json[] | undefined, mode: string): { logs?: Json[]; logCount?: number } {
  if (!logs || mode === 'none') return logs ? { logCount: logs.length } : {};
  if (mode === 'all') return { logs, logCount: logs.length };
  const kept = logs.filter(entry => !(isJsonObject(entry) && /^(debug|trace|verbose)$/i.test(String(entry.level))));
  return { logs: kept.slice(0, LOG_LIMIT), logCount: logs.length };
}

function shapeOutcome(outcome: Outcome, logMode: string): JsonObject {
  const { body, bodyTruncated } = boundedBody(outcome.body);
  const data: JsonObject = { status: outcome.status, headers: outcome.headers, body, durationMs: outcome.durationMs };
  if (bodyTruncated) data.bodyTruncated = true;
  if (outcome.serverTiming) data.serverTiming = outcome.serverTiming;
  if (outcome.rolledBack !== undefined) data.rolledBack = outcome.rolledBack;
  if (outcome.blocked) data.blocked = { ...outcome.blocked };
  if (outcome.changes) data.changes = outcome.changes;
  if (outcome.effects) data.effects = outcome.effects;
  Object.assign(data, boundedLogs(outcome.logs, logMode));
  if (outcome.truncated) data.truncated = outcome.truncated;
  if (outcome.traceId) data.traceId = outcome.traceId;
  if (outcome.timing !== undefined) data.timing = outcome.timing;
  return data;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function changeSummary(changes: Json[] | undefined): string {
  if (!changes?.length) return 'no writes';
  const counts = new Map<string, number>();
  for (const change of changes) {
    if (!isJsonObject(change)) continue;
    const key = `${String(change.operation ?? 'change')} ${String(change.table ?? change.namespace ?? change.store ?? '')}`.trim();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].map(([key, n]) => n > 1 ? `${key} ×${n}` : key).join(', ');
}

async function sendAllowed(context: ToolContext, method: string) {
  if (isSafeMethod(method)) return;
  if (context.allowSend === 'off') throw new ToolInputError(`Send is off for ${method} requests: this MCP server was started without --allow-send. Use preview_request, which runs the real handler and rolls it back.`);
  const caps = await context.client.capabilities();
  const problem = sendPolicyProblem(caps, context.allowSend);
  if (problem) throw new ToolInputError(problem);
}

/** list_journeys, describe_journey and the run tools are listed only when the API publishes
 *  journeys, and the run tools only when a run can actually do something: Preview sessions, or
 *  Send allowed at all (for a Send-only journey). */
const journeysAvailable = (caps: JsonObject) => journeySources(caps).length > 0;
const runsAvailable = (caps: JsonObject, context: ToolContext) => journeysAvailable(caps) && (caps.previewSessions === true || context.allowSend !== 'off');

const TOOLS: Tool[] = [
  {
    name: 'get_api',
    title: 'Get the API',
    description: 'What this API is and how Sendproof can work with it: its name, environment, database and data stores, who is signed in, how to sign in, how many operations can be previewed, and whether Send can be traced. Call this first. refresh: true re-reads the capabilities and OpenAPI documents.',
    inputSchema: obj({ refresh: { type: 'boolean', description: 'Re-read capabilities and the OpenAPI documents.' } }),
    outputSchema: open({ apiName: { type: 'string' }, environment: { type: ['string', 'null'] }, operations: { type: 'integer' } }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    async run(args, { client, allowSend, toolsChanged }) {
      const refresh = args.refresh === true;
      const caps = await client.capabilities(refresh);
      const documents = await client.documents(refresh);
      if (refresh) toolsChanged?.();
      const ops = await client.operations();
      const previewable = ops.filter(op => client.previewStatus(caps, op).previewable).length;
      const identity = isJsonObject(caps.identity) ? caps.identity : null;
      const data: JsonObject = {
        apiName: String(caps.apiName ?? 'API'),
        environment: (caps.environment as Json) ?? null,
        database: (caps.database as Json) ?? null,
        binding: (caps.binding as Json) ?? null,
        signedIn: identity,
        authProviders: (caps.authProviders as Json) ?? [],
        dataStores: (caps.dataStores as Json) ?? [],
        documents: documents.map(d => ({ name: d.name, url: d.url, title: isJsonObject(d.document.info) ? (d.document.info.title ?? null) : null, version: isJsonObject(d.document.info) ? (d.document.info.version ?? null) : null })),
        operations: ops.length,
        previewable,
        observedSend: caps.observedSend === true,
        journeyDocuments: journeySources(caps).length,
        send: allowSend === 'off' ? 'Only GET, HEAD and OPTIONS; other methods need --allow-send' : allowSend === 'development' ? 'Allowed in Development' : 'Allowed in any environment',
      };
      const who = identity?.name ? `signed in as ${String(identity.name)}` : 'not signed in';
      return { summary: `${data.apiName} (${String(caps.environment ?? 'unknown environment')}), ${who}: ${plural(ops.length, 'operation')}, ${previewable} previewable.`, data };
    },
  },
  {
    name: 'list_operations',
    title: 'List operations',
    description: 'The API’s operations: operationId, method, path, summary, tag, whether Preview is available (and why not), whether it needs sign-in, and whether it is deprecated. Filter with search (matches id, path, summary and tag) or tag.',
    inputSchema: obj({ search: str('Words to match against operationId, path, summary and tag.'), tag: str('Only operations with this tag.'), previewable: { type: 'boolean', description: 'Only operations Preview is (or isn’t) available for.' } }),
    outputSchema: open({ operations: { type: 'array' }, total: { type: 'integer' } }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    async run(args, { client }) {
      const caps = await client.capabilities();
      const search = text(args.search, 'search')?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
      const tag = text(args.tag, 'tag')?.toLowerCase();
      const all = await client.operations();
      const rows = all.map(op => {
        const preview = client.previewStatus(caps, op);
        return { op, row: {
          operationId: op.id, method: op.method, path: op.path, summary: op.summary, tag: op.tag,
          previewable: preview.previewable, ...(preview.previewable ? {} : { previewReason: preview.reason ?? null }),
          secured: op.secured, deprecated: op.deprecated, ...(all.some(o => o.document !== op.document) ? { document: op.document } : {}),
        } };
      }).filter(({ op, row }) => {
        if (tag && op.tag.toLowerCase() !== tag) return false;
        if (typeof args.previewable === 'boolean' && row.previewable !== args.previewable) return false;
        const hay = `${op.id} ${op.method} ${op.path} ${op.summary} ${op.tag}`.toLowerCase();
        return search.every(word => hay.includes(word));
      }).map(({ row }) => row as JsonObject);
      return { summary: `${plural(rows.length, 'operation')}${rows.length !== all.length ? ` of ${all.length}` : ''}.`, data: { operations: rows, total: all.length } };
    },
  },
  {
    name: 'describe_operation',
    title: 'Describe an operation',
    description: 'Everything needed to call one operation: its parameters (with schemas, examples and lookups for real values), request body schema, responses, security, and whether Preview is available. Named models appear as { "$ref": "Name" }; read them with describe_model.',
    inputSchema: obj({ operationId: str('The operationId, or "METHOD /path".') }, ['operationId']),
    outputSchema: open({ operationId: { type: 'string' }, method: { type: 'string' }, path: { type: 'string' } }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    async run(args, { client }) {
      const op = await client.findOperation(required(args, 'operationId'));
      const caps = await client.capabilities();
      const preview = client.previewStatus(caps, op);
      const data: JsonObject = {
        operationId: op.id, method: op.method, path: op.path, summary: op.summary, description: op.description ?? null,
        tag: op.tag, deprecated: op.deprecated, secured: op.secured,
        security: (op.operation.security as Json) ?? (op.source.security as Json) ?? [],
        preview: { available: preview.previewable, ...(preview.reason ? { reason: preview.reason } : {}), ...(preview.stores ? { stores: preview.stores } : {}) },
        parameters: op.parameters.map(p => ({
          name: p.name, in: p.in, required: p.required, description: p.description ?? null,
          schema: compactSchema(p.schema, op.source) ?? null, ...(p.example !== undefined ? { example: p.example } : {}),
          ...(isJsonObject(p.schema) && p.schema['x-lookup'] ? { lookup: true } : {}),
        })),
        requestBody: requestBody(op, op.source) ?? null,
        responses: responses(op, op.source),
      };
      const extensions = Object.fromEntries(Object.entries(op.operation).filter(([key]) => key.startsWith('x-')));
      if (Object.keys(extensions).length) data.extensions = extensions;
      return { summary: `${op.method} ${op.path}: ${op.summary || op.id}${preview.previewable ? '' : ' (no Preview)'}.`, data };
    },
  },
  {
    name: 'list_models',
    title: 'List models',
    description: 'The named schemas (components) in the API’s OpenAPI documents, with their descriptions. Filter with search.',
    inputSchema: obj({ search: str('Words to match against the model name and description.') }),
    outputSchema: open({ models: { type: 'array' } }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    async run(args, { client }) {
      const search = text(args.search, 'search')?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
      const models: JsonObject[] = [];
      for (const { name: document, document: doc } of await client.documents()) {
        const schemas = isJsonObject(doc.components) && isJsonObject(doc.components.schemas) ? doc.components.schemas : {};
        for (const [name, schema] of Object.entries(schemas)) {
          if (!isJsonObject(schema)) continue;
          const description = typeof schema.description === 'string' ? schema.description : '';
          if (!search.every(word => `${name} ${description}`.toLowerCase().includes(word))) continue;
          models.push({
            name, description, type: (schema.type as Json) ?? (schema.oneOf ? 'oneOf' : schema.enum ? 'enum' : null),
            properties: isJsonObject(schema.properties) ? Object.keys(schema.properties).length : 0, document,
          });
        }
      }
      return { summary: `${plural(models.length, 'model')}.`, data: { models } };
    },
  },
  {
    name: 'describe_model',
    title: 'Describe a model',
    description: 'One named schema: its properties, types, required fields, enums, examples and nested references, and the operations that use it.',
    inputSchema: obj({ name: str('The model name from list_models or a { "$ref": "Name" }.') }, ['name']),
    outputSchema: open({ name: { type: 'string' }, schema: anyJson, usedBy: { type: 'array' } }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    async run(args, { client }) {
      const name = refName(required(args, 'name'));
      for (const { document } of await client.documents()) {
        const schemas = isJsonObject(document.components) && isJsonObject(document.components.schemas) ? document.components.schemas : {};
        if (!Object.hasOwn(schemas, name)) continue;
        const marker = `"#/components/schemas/${name.replace(/~/g, '~0').replace(/\//g, '~1')}"`;
        const usedBy = (await client.operations()).filter(op => JSON.stringify(op.operation).includes(marker)).map(op => op.id);
        return { summary: `${name}: used by ${plural(usedBy.length, 'operation')}.`, data: { name, schema: compactSchema(schemas[name], document, 3) ?? null, usedBy } };
      }
      throw new ToolInputError(`No model “${name}”. Call list_models to see them.`);
    },
  },
  {
    name: 'find_values',
    title: 'Find real values for a field',
    description: 'Real values a field accepts, so requests use records that exist: for a lookup field (x-lookup), the records the signed-in user can see (such as customers or orders, with their IDs and names); for an enum, its values. field is a parameter name or a body path such as "customerId" or "lines[].variantId".',
    inputSchema: obj({ operationId: str('The operation the field belongs to.'), field: str('A parameter name, or a body path such as "lines[].variantId".'), search: str('Text to narrow the lookup, when it supports search.') }, ['operationId', 'field']),
    outputSchema: open({ field: { type: 'string' }, values: { type: 'array' } }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    async run(args, { client }) {
      const op = await client.findOperation(required(args, 'operationId'));
      const field = required(args, 'field');
      const parameter = op.parameters.find(p => p.name === field);
      let schema: JsonObject | undefined = parameter?.schema ? schemaAt(parameter.schema, '', op.source) : undefined;
      if (!parameter) {
        const declared = dereference(op.operation.requestBody, op.source);
        const media = isJsonObject(declared) && isJsonObject(declared.content) ? Object.values(declared.content).find(isJsonObject) : undefined;
        schema = media ? schemaAt(media.schema, field, op.source) : undefined;
      }
      if (!schema) {
        const declared = dereference(op.operation.requestBody, op.source);
        const media = isJsonObject(declared) && isJsonObject(declared.content) ? Object.values(declared.content).find(isJsonObject) : undefined;
        const parent = field.includes('.') ? field.slice(0, field.lastIndexOf('.')) : '';
        const at = media ? schemaAt(media.schema, parent, op.source) : undefined;
        const names = [...op.parameters.map(p => p.name), ...(at && isJsonObject(at.properties) ? Object.keys(at.properties).map(n => parent ? `${parent}.${n}` : n) : [])];
        throw new ToolInputError(`${op.id} has no parameter or body field “${field}”.${names.length ? ` Fields here: ${names.join(', ')}.` : ''}`);
      }
      const lookup = isJsonObject(schema['x-lookup']) ? schema['x-lookup'] : undefined;
      if (lookup) {
        const values = await client.lookup(lookup, text(args.search, 'search'));
        return { summary: `${plural(values.length, 'value')} for ${field}.`, data: { field, source: 'lookup', values: values as Json } };
      }
      if (Array.isArray(schema.enum)) return { summary: `${plural(schema.enum.length, 'value')} for ${field}.`, data: { field, source: 'enum', values: schema.enum.map(value => ({ value, label: String(value) })) } };
      const example = schema.example ?? (Array.isArray(schema.examples) ? schema.examples[0] : undefined);
      return {
        summary: `${field} has no lookup or enum${example !== undefined ? '; its example is included' : ''}.`,
        data: { field, source: 'none', values: example !== undefined ? [{ value: example, label: 'example' }] : [], schema: compactSchema(schema, op.source, 2) ?? null },
      };
    },
  },
  {
    name: 'preview_request',
    title: 'Preview a request',
    description: 'Runs the operation’s real handler inside a transaction and rolls it back, then returns the response plus exactly what it would have written (database changes before and after, store commands), the side effects it would have had (emails, messages, jobs) and its logs and SQL. Nothing is written. Prefer this to send_request. If a store that can’t roll back (such as Redis) would be written, the Preview stops before the write and says so in "blocked".',
    inputSchema: obj(requestProperties, ['operationId']),
    outputSchema: outcomeSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async run(args, { client }) {
      const op = await client.findOperation(required(args, 'operationId'));
      const caps = await client.capabilities();
      const status = client.previewStatus(caps, op);
      if (!status.previewable) throw new ToolInputError(`Preview isn’t available for ${op.id}: ${status.reason}${isSafeMethod(op.method) ? ' It reads only, so send_request is safe.' : ''}`);
      const outcome = await client.preview(op, requestInput(args));
      const data = shapeOutcome(outcome, text(args.logs, 'logs') ?? 'summary');
      if (outcome.blocked) {
        data.written = false;
        const why = outcome.blocked.detail.replace(/^Preview unavailable:\s*/i, '');
        return { summary: `Preview stopped before the write: ${why}${outcome.blocked.operation ? ` (${outcome.blocked.operation})` : ''}. Nothing was written; only a Send can run it.`, data };
      }
      return { summary: `${op.method} ${op.path} → ${outcome.status} in ${outcome.durationMs} ms, rolled back: ${changeSummary(outcome.changes)}${outcome.effects?.length ? `, ${plural(outcome.effects.length, 'effect')} held` : ''}.`, data };
    },
  },
  {
    name: 'send_request',
    title: 'Send a request',
    description: 'Sends the request for real and commits whatever it writes. GET, HEAD and OPTIONS are always allowed. Other methods need the server started with --allow-send (Development only, or --allow-send-anywhere) and confirmSend: true. When the API supports it, the Send is traced and the result includes the writes, effects and logs it made.',
    inputSchema: obj({ ...requestProperties, confirmSend: { type: 'boolean', description: 'Must be true for methods other than GET, HEAD and OPTIONS: the request commits.' }, trace: { type: 'boolean', description: 'Ask for a trace of what the Send wrote. Defaults to true when the API supports it.' } }, ['operationId']),
    outputSchema: outcomeSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    async run(args, context) {
      const { client } = context;
      const op = await client.findOperation(required(args, 'operationId'));
      await sendAllowed(context, op.method);
      if (!isSafeMethod(op.method) && args.confirmSend !== true) throw new ToolInputError(`${op.method} ${op.path} commits. Pass confirmSend: true to send it, or use preview_request to see what it would do first.`);
      const caps = await client.capabilities();
      const traceable = caps.observedSend === true && client.previewStatus(caps, op).previewable;
      const outcome = await client.send(op, requestInput(args), { trace: args.trace === false ? false : traceable });
      const data = shapeOutcome(outcome, text(args.logs, 'logs') ?? 'summary');
      data.committed = !isSafeMethod(op.method);
      const traced = outcome.traceId ? `, traced: ${changeSummary(outcome.changes)}` : '';
      return { summary: `${op.method} ${op.path} → ${outcome.status} in ${outcome.durationMs} ms${data.committed ? ', committed' : ''}${traced}.`, data };
    },
  },
  {
    name: 'get_trace',
    title: 'Get a Send trace',
    description: 'The writes, effects, logs and timing an observed Send recorded, by the traceId send_request returned. Traces expire after a few minutes and belong to the user who sent the request.',
    inputSchema: obj({ traceId: str('The traceId from send_request.') }, ['traceId']),
    outputSchema: open({ traceId: { type: 'string' }, changes: { type: 'array' }, effects: { type: 'array' }, logs: { type: 'array' } }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    async run(args, { client }) {
      const trace = await client.trace(required(args, 'traceId'));
      return { summary: `Trace ${trace.traceId}: ${changeSummary(trace.changes)}.`, data: trace as unknown as JsonObject };
    },
  },
  {
    name: 'list_personas',
    title: 'List development personas',
    description: 'The seeded development accounts this API offers (email, name and role), for trying operations as different users. Switch with switch_persona.',
    inputSchema: obj({}),
    outputSchema: open({ personas: { type: 'array' } }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    available: (caps, { client }) => Boolean(client.personasProvider(caps)),
    async run(_args, { client }) {
      const personas = await client.personas();
      return { summary: `${plural(personas.length, 'persona')}.`, data: { personas: personas as unknown as Json[] } };
    },
  },
  {
    name: 'switch_persona',
    title: 'Switch persona',
    description: 'Signs this session in as one of the development personas, by email. Later requests run as that user.',
    inputSchema: obj({ email: str('A persona’s email from list_personas.') }, ['email']),
    outputSchema: open({ signedIn: anyJson }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    available: (caps, { client }) => Boolean(client.personasProvider(caps)),
    async run(args, { client, toolsChanged }) {
      const caps = await client.switchPersona(required(args, 'email'));
      toolsChanged?.();
      const identity = isJsonObject(caps.identity) ? caps.identity : null;
      return { summary: `Signed in as ${String(identity?.name ?? args.email)}.`, data: { signedIn: identity } };
    },
  },
  {
    name: 'list_journeys',
    title: 'List journeys',
    description: 'The journeys this API publishes: multi-step workflows (Arazzo) such as taking an order through to shipment, with their steps and operations.',
    inputSchema: obj({}),
    outputSchema: open({ journeys: { type: 'array' } }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    available: journeysAvailable,
    async run(_args, { client }) {
      const journeys = await listJourneys(client);
      return { summary: `${plural(journeys.length, 'journey')}.`, data: { journeys: journeys as unknown as Json[] } };
    },
  },
  {
    name: 'describe_journey',
    title: 'Describe a journey',
    description: 'One journey: its inputs, each step’s operation, the values it binds from inputs and earlier steps, its success criteria and outputs, what each step is expected to write, and the approved differences that apply.',
    inputSchema: obj({ journeyId: str('The journeyId (Arazzo workflowId) from list_journeys.') }, ['journeyId']),
    outputSchema: open({ journeyId: { type: 'string' }, steps: { type: 'array' } }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    available: journeysAvailable,
    async run(args, { client }) {
      const journey = await describeJourney(client, required(args, 'journeyId'));
      return { summary: `${journey.name}: ${plural(journey.steps.length, 'step')}.`, data: journey as unknown as JsonObject };
    },
  },
  {
    name: 'start_run',
    title: 'Start a journey run',
    description: 'Starts a run of one journey: preview opens one Preview session every step shares (so step 3 sees what step 1 wrote, nothing committed); send sends every step for real and traces it (needs confirmSend: true and the server started with --allow-send or --allow-send-anywhere). Signs in as the journey’s own persona first, when it names one. Call run_step or run_remaining next.',
    inputSchema: obj({
      journeyId: str('The journeyId (Arazzo workflowId) from list_journeys.'),
      mode: { type: 'string', enum: ['preview', 'send'], description: 'preview rolls every step back; send commits.' },
      inputs: { type: 'object', description: 'The journey’s inputs, by name.', additionalProperties: true },
      confirmSend: { type: 'boolean', description: 'Must be true for mode: "send": it commits.' },
    }, ['journeyId', 'mode']),
    outputSchema: open({ runId: { type: 'string' }, status: { type: 'string' } }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    available: runsAvailable,
    async run(args, context) {
      const journeyId = required(args, 'journeyId');
      const mode = required(args, 'mode');
      if (mode !== 'preview' && mode !== 'send') throw new ToolInputError('mode must be "preview" or "send".');
      const run = exportRun(await startRun(context.client, context.allowSend, { journeyId, mode, inputs: record(args.inputs, 'inputs'), confirmSend: args.confirmSend === true }));
      return { summary: `Started run ${run.runId} of “${run.journeyId}” (${run.mode}): ${plural(run.steps.length, 'step')}.`, data: run as unknown as JsonObject };
    },
  },
  {
    name: 'run_step',
    title: 'Run one journey step',
    description: 'Runs the next pending step of a run, or stepId. overrides replaces individual bound values (path, query, headers or body fields) before it runs. Returns the step’s response, success criteria, outputs and write comparison (findings).',
    inputSchema: obj({
      runId: str('The runId from start_run.'),
      stepId: str('A specific step, instead of the next pending one.'),
      overrides: open({ path: open(), query: open(), headers: open(), body: anyJson }),
    }, ['runId']),
    outputSchema: open({ stepId: { type: 'string' }, status: { type: 'string' }, findings: { type: 'array' } }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    available: runsAvailable,
    async run(args) {
      const overrides = record(args.overrides, 'overrides') ?? {};
      const step = await runStep(required(args, 'runId'), text(args.stepId, 'stepId'), {
        path: record(overrides.path, 'overrides.path'), query: record(overrides.query, 'overrides.query'),
        headers: record(overrides.headers, 'overrides.headers'), body: overrides.body,
      });
      const bad = step.findings.filter(f => f.kind !== 'match' && f.kind !== 'approved');
      return { summary: `${step.stepId} → ${step.status}${step.httpStatus ? ` (HTTP ${step.httpStatus})` : ''}${bad.length ? `, ${plural(bad.length, 'finding')} to look at` : ''}.`, data: step as unknown as JsonObject };
    },
  },
  {
    name: 'run_remaining',
    title: 'Run the rest of a journey',
    description: 'Runs every pending step of a run in order, stopping where the journey itself stops (a step refused unexpectedly, failing its success criteria, or blocked). Returns the whole run.',
    inputSchema: obj({ runId: str('The runId from start_run.') }, ['runId']),
    outputSchema: open({ runId: { type: 'string' }, status: { type: 'string' }, steps: { type: 'array' } }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    available: runsAvailable,
    async run(args) {
      const run = exportRun(await runRemaining(required(args, 'runId')));
      return { summary: `${run.journeyId} (${run.runId}): ${run.status}, ${plural(run.steps.length, 'step')}.`, data: run as unknown as JsonObject };
    },
  },
  {
    name: 'get_run',
    title: 'Get a journey run',
    description: 'The whole run as recorded so far: every step’s response, criteria, outputs and findings, and the approved differences used, unused or expired.',
    inputSchema: obj({ runId: str('The runId from start_run.') }, ['runId']),
    outputSchema: open({ runId: { type: 'string' }, status: { type: 'string' }, steps: { type: 'array' } }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    available: runsAvailable,
    async run(args) {
      const run = getRun(required(args, 'runId'));
      return { summary: `${run.journeyId} (${run.runId}): ${run.status}.`, data: run as unknown as JsonObject };
    },
  },
  {
    name: 'end_run',
    title: 'End a journey run',
    description: 'Ends a run and rolls back its Preview session (a Send run has none to roll back). Ending an already-ended or unknown run does nothing.',
    inputSchema: obj({ runId: str('The runId from start_run.') }, ['runId']),
    outputSchema: open({ ended: { type: 'boolean' } }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    available: runsAvailable,
    async run(args) {
      const runId = required(args, 'runId');
      await endRun(runId);
      return { summary: `Ended run ${runId}.`, data: { ended: true } };
    },
  },
  {
    name: 'draft_approved_difference',
    title: 'Draft an approved difference',
    description: 'Drafts one approved-difference record per differing field of a finding (or one for a whole missing/extra write), to relax a known, reasoned difference (journeys.md, "Approved differences"). Returns C# (ApprovedDifference<T>, to paste into the journey’s source and commit) when the journey is defined in code, or the JSON record when it comes from a file. Never writes a file: the approval is the commit’s code review.',
    inputSchema: obj({
      runId: str('The runId from start_run.'), stepId: str('The step the finding is on.'),
      findingId: str('The finding’s id, from run_step or get_run (such as "write:2" or "missing:0").'),
      reason: str('Why the difference is expected and acceptable.'),
    }, ['runId', 'stepId', 'findingId', 'reason']),
    outputSchema: open({ source: { type: 'string' }, records: { type: 'array' } }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    available: runsAvailable,
    async run(args) {
      const draft = await draftApprovedDifference({
        runId: required(args, 'runId'), stepId: required(args, 'stepId'),
        findingId: required(args, 'findingId'), reason: required(args, 'reason'),
      });
      return { summary: `${plural(draft.records.length, 'record')} drafted for ${draft.findingId} (${draft.source === 'file' ? 'JSON' : 'C#'}).`, data: draft as unknown as JsonObject };
    },
  },
];

export async function listTools(context: ToolContext) {
  let caps: JsonObject | undefined;
  try { caps = await context.client.capabilities(); } catch { caps = undefined; }
  return TOOLS.filter(tool => !tool.available || (caps && tool.available(caps, context))).map(tool => ({
    name: tool.name, title: tool.title, description: tool.description,
    inputSchema: tool.inputSchema, outputSchema: tool.outputSchema, annotations: { title: tool.title, ...tool.annotations },
  }));
}

export async function callTool(name: string, args: JsonObject, context: ToolContext) {
  const tool = TOOLS.find(t => t.name === name);
  if (!tool) return { isError: true, content: [{ type: 'text' as const, text: `Unknown tool “${name}”.` }] };
  try {
    const result = await tool.run(args ?? {}, context);
    return { content: [{ type: 'text' as const, text: result.summary }], structuredContent: result.data };
  } catch (error) {
    if (error instanceof ToolInputError || error instanceof SendproofError || error instanceof Error) {
      return { isError: true, content: [{ type: 'text' as const, text: error.message }] };
    }
    return { isError: true, content: [{ type: 'text' as const, text: String(error) }] };
  }
}

export const toolNames = TOOLS.map(tool => tool.name);
