#!/usr/bin/env node
// sendproof: the Sendproof command line. `sendproof mcp --api <url>` runs the MCP server over
// stdio; `sendproof journeys list|run` is the same journey runner from a terminal or CI.
// Everything outside the MCP protocol goes to stderr, so stdout stays a clean JSON-RPC stream.

import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SendproofClient, SendproofError, type SendPolicy } from './client.js';
import { listJourneys } from './journeys.js';
import { endAllRuns, endRun, exportRun, runRemaining, startRun, toJUnit, type Run, type StepResult } from './journeys-run.js';
import { isJsonObject, type JsonObject } from './openapi.js';
import { createServer, VERSION } from './server.js';

const HELP = `sendproof ${VERSION}

Usage
  sendproof mcp --api <url> [options]                      Run the MCP server over stdio
  sendproof journeys list --api <url> [options]             List the journeys the API publishes
  sendproof journeys run [journeyId...] --api <url> [options]   Run one, several or every journey

Connection
  --api <url>              The API's base URL, with any path base (http://127.0.0.1:5189)
  --mount <path>           Where Sendproof is mounted (default /sendproof)
  --header "Name: value"   Send a header on every request, such as Authorization (repeatable)
  --cookie name=value      Start with a session cookie (repeatable)
  --persona <email>        Switch to a development persona at start
  --sign-in <email>        Sign in with a password provider; the password comes from SENDPROOF_PASSWORD
  --timeout <ms>           Abandon a request after this long (default 30000)

Send
  --allow-send             Let a write commit (send_request, or a Send journey run) when the API reports Development
  --allow-send-anywhere    Let a write commit in any environment

journeys run
  --all                    Run every journey the API publishes, instead of naming them
  --mode preview|send      preview (default) rolls every step back; send sends and commits every step
  --yes                    Required for --mode send: confirms the run commits
  --inputs <file>          A JSON file of the journey's inputs (same inputs for every journey named)
  --out <file>             Write the run (or runs, as a JSON array) to this file
  --junit <file>           Write a JUnit XML report (one <testsuite> per journey) to this file

Other
  --help, --version

Example MCP client configuration
  { "mcpServers": { "store-api": { "command": "npx", "args": ["-y", "@sendproof/cli", "mcp", "--api", "http://127.0.0.1:5189"] } } }
`;

function fail(message: string): never {
  process.stderr.write(`sendproof: ${message}\n`);
  process.exit(2);
}

const options = {
  api: { type: 'string' as const }, mount: { type: 'string' as const },
  header: { type: 'string' as const, multiple: true as const }, cookie: { type: 'string' as const, multiple: true as const },
  persona: { type: 'string' as const }, 'sign-in': { type: 'string' as const }, timeout: { type: 'string' as const },
  'allow-send': { type: 'boolean' as const }, 'allow-send-anywhere': { type: 'boolean' as const },
  all: { type: 'boolean' as const }, mode: { type: 'string' as const }, yes: { type: 'boolean' as const },
  inputs: { type: 'string' as const }, out: { type: 'string' as const }, junit: { type: 'string' as const },
  help: { type: 'boolean' as const, short: 'h' as const }, version: { type: 'boolean' as const, short: 'v' as const },
};

type Values = ReturnType<typeof parseArgs<{ options: typeof options }>>['values'];

function connectionOptions(values: Values) {
  const headers: Record<string, string> = {};
  for (const line of values.header ?? []) {
    const index = line.indexOf(':');
    if (index <= 0) fail(`--header needs "Name: value", got “${line}”.`);
    headers[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  const timeoutMs = values.timeout === undefined ? undefined : Number(values.timeout);
  if (timeoutMs !== undefined && !(timeoutMs > 0)) fail('--timeout must be a positive number of milliseconds.');
  if (!values.api) fail('--api is required, such as --api http://127.0.0.1:5189');
  return { api: values.api, mount: values.mount, headers, cookies: values.cookie, timeoutMs };
}

// Signing in before the first use means the signed-in user is already reflected (tools/list, the
// first journey run).
async function signInAndSwitch(client: SendproofClient, values: Values) {
  try {
    if (values['sign-in']) {
      const password = process.env.SENDPROOF_PASSWORD;
      if (!password) fail('--sign-in needs the password in the SENDPROOF_PASSWORD environment variable.');
      await client.signIn(values['sign-in'], password);
    }
    if (values.persona) await client.switchPersona(values.persona);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

async function connect(values: Values) {
  let client: SendproofClient;
  try {
    client = new SendproofClient(connectionOptions(values));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  await signInAndSwitch(client, values);
  return client;
}

async function runMcp(values: Values) {
  const allowSend: SendPolicy = values['allow-send-anywhere'] ? 'anywhere' : values['allow-send'] ? 'development' : 'off';
  let created;
  try {
    created = createServer({ ...connectionOptions(values), allowSend });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const { server, client } = created;
  await signInAndSwitch(client, values);
  const shutdown = async () => { await endAllRuns(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await server.connect(new StdioServerTransport());
  process.stderr.write(`sendproof ${VERSION}: MCP server for ${client.base.href} on stdio${allowSend === 'off' ? '' : `, Send allowed ${allowSend === 'anywhere' ? 'anywhere' : 'in Development'}`}\n`);
}

const statusMark: Record<string, string> = { passed: '✓', failed: '✗', refused: '✗', blocked: '✗', skipped: '-', pending: '·' };

/** Short, readable findings for the terminal: "ServiceLevel differs", "StockReservations
 *  missing", "Carrier covered by AD-0011" (journeys.md, "Comparing and reporting"). A write
 *  finding with fields reports per field (compare.js only sets a top-level `record` for a whole
 *  missing/extra write, never for one compared field by field); a whole-write finding (no
 *  fields: missing, extra, or covered by a record) reports once. */
function findingLines(step: StepResult): string[] {
  const lines: string[] = [];
  for (const finding of step.findings) {
    if (finding.kind === 'match') continue;
    if (finding.fields.length) {
      for (const field of finding.fields) {
        if (field.state === 'differs') lines.push(`${field.name} differs`);
        else if (field.state === 'approved') lines.push(`${field.name} covered by ${field.record}`);
      }
    } else if (finding.kind === 'approved') lines.push(`${finding.target} covered by ${finding.record}`);
    else lines.push(`${finding.target} ${finding.kind === 'unchecked' ? 'not checked' : finding.kind}`);
  }
  return lines;
}

function printRun(run: Run) {
  process.stderr.write(`\n${run.name} (${run.journeyId}) — ${run.mode}\n`);
  for (const step of run.steps) {
    const mark = statusMark[step.status] ?? '?';
    const timing = step.durationMs === null ? '' : ` ${step.durationMs}ms`;
    const http = step.httpStatus === null ? '' : ` ${step.httpStatus}`;
    const findings = findingLines(step);
    process.stderr.write(`  ${mark} ${step.stepId}${http}${timing}${findings.length ? `  ${findings.join(', ')}` : ''}\n`);
  }
  const passed = run.steps.filter(s => s.status === 'passed').length;
  const failed = run.steps.filter(s => s.status === 'failed' || s.status === 'refused' || s.status === 'blocked').length;
  const skipped = run.steps.filter(s => s.status === 'skipped').length;
  process.stderr.write(`  ${run.status.toUpperCase()}: ${passed} passed, ${failed} failed, ${skipped} skipped`
    + `${run.approvedUsed.length ? `, ${run.approvedUsed.length} approved difference(s) used` : ''}\n`);
}

async function runJourneys(action: string, journeyIds: string[], values: Values) {
  const allowSend: SendPolicy = values['allow-send-anywhere'] ? 'anywhere' : values['allow-send'] ? 'development' : 'off';
  const client = await connect(values);

  if (action === 'list') {
    const journeys = await listJourneys(client);
    if (!journeys.length) { process.stdout.write('No journeys published.\n'); return; }
    for (const journey of journeys) process.stdout.write(`${journey.journeyId}\t${journey.name}\t${journey.steps} step(s)\t${journey.document}\n`);
    return;
  }
  if (action !== 'run') fail(`unknown "journeys" action “${action}”. Run sendproof --help.`);

  let ids = journeyIds;
  if (values.all) {
    if (ids.length) fail('Name journeys or pass --all, not both.');
    ids = (await listJourneys(client)).map(j => j.journeyId);
    if (!ids.length) fail('This API publishes no journeys.');
  }
  if (!ids.length) fail('Name one or more journeyIds, or pass --all. Run "sendproof journeys list" to see them.');

  const mode = values.mode === undefined ? 'preview' : values.mode;
  if (mode !== 'preview' && mode !== 'send') fail('--mode must be "preview" or "send".');
  if (mode === 'send' && !values.yes) fail('--mode send writes for real: pass --yes to confirm.');

  let inputs: JsonObject = {};
  if (values.inputs) {
    const parsed: unknown = JSON.parse(await readFile(values.inputs, 'utf8'));
    if (!isJsonObject(parsed)) fail(`--inputs ${values.inputs} must contain a JSON object.`);
    inputs = parsed;
  }

  const runs: Run[] = [];
  let couldntRun = false, anyFailed = false;
  for (const journeyId of ids) {
    let runId: string | undefined;
    try {
      const started = await startRun(client, allowSend, { journeyId, mode, inputs, confirmSend: values.yes === true, surface: 'cli', skipSendOnly: values.all === true });
      if (started.status === 'skipped') {
        // A Send-only journey in a Preview run of every journey: reported, and not a failure.
        runs.push(started);
        process.stderr.write(`\n${started.name} (${started.journeyId}) — ${started.mode}\n  - skipped: ${started.skipReason}\n`);
        continue;
      }
      runId = started.runId;
      const run = await runRemaining(started.runId);
      runs.push(run);
      printRun(run);
      if (run.status !== 'passed') anyFailed = true;
    } catch (error) {
      couldntRun = true;
      process.stderr.write(`\n${journeyId}: couldn’t run — ${error instanceof Error ? error.message : String(error)}\n`);
    } finally {
      if (runId) await endRun(runId);
    }
  }

  if (values.out) await writeFile(values.out, JSON.stringify(runs.length === 1 ? exportRun(runs[0]) : runs.map(exportRun), null, 2) + '\n');
  if (values.junit) {
    const suites = runs.map(run => toJUnit(run).replace(/^<\?xml[^\n]*\n/, '')).join('');
    await writeFile(values.junit, `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n${suites}</testsuites>\n`);
  }

  process.exitCode = couldntRun ? 2 : anyFailed ? 1 : 0;
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options });
  if (values.version) { process.stdout.write(`${VERSION}\n`); return; }
  if (values.help || positionals.length === 0) { process.stdout.write(HELP); return; }

  if (positionals[0] === 'mcp') return runMcp(values);
  if (positionals[0] === 'journeys') {
    if (!positionals[1]) fail('Usage: sendproof journeys list|run ... --api <url>. Run sendproof --help.');
    return runJourneys(positionals[1], positionals.slice(2), values);
  }
  fail(`unknown command “${positionals[0]}”. Run sendproof --help.`);
}

main().catch(error => {
  if (error instanceof SendproofError) fail(error.message);
  throw error;
});
