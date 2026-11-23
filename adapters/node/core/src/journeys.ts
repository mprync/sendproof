import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileJourney, type CodeJourney } from './journey-builder.js';
import { localPath } from './paths.js';

export const journeyPrefix = '/sendproof/journeys/';
const documentId = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const methods = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

interface ArazzoDocument {
  arazzo: string;
  info: { title: string; version?: string };
  sourceDescriptions: { url: string; name?: string; type?: string }[];
  workflows?: unknown[];
}

interface Entry {
  arazzo: ArazzoDocument;
  expectations: unknown;
  source: 'code' | 'file';
}

interface CodeOptions {
  apiName: string;
  openApiUrl: string;
  openApiDocument?: object;
  document?: { id?: string; title?: string };
  development: boolean;
  enabled: boolean;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function operationIds(document: object) {
  const ids = new Set<string>();
  if (!isObject(document) || !isObject(document.paths)) return ids;
  for (const [path, rawItem] of Object.entries(document.paths)) {
    if (!path.startsWith('/') || !isObject(rawItem)) continue;
    let item: unknown = rawItem;
    if (typeof rawItem.$ref === 'string' && rawItem.$ref.startsWith('#/')) {
      item = rawItem.$ref.slice(2).split('/').reduce<unknown>((node, token) => {
        const key = token.replace(/~1/g, '/').replace(/~0/g, '~');
        return isObject(node) && Object.hasOwn(node, key) ? node[key] : undefined;
      }, document);
    }
    if (!isObject(item)) continue;
    for (const method of methods) {
      const operation = item[method];
      if (isObject(operation) && typeof operation.operationId === 'string') ids.add(operation.operationId);
    }
  }
  return ids;
}

function registerCode(entries: Map<string, Entry>, journeys: CodeJourney[], options: CodeOptions) {
  const { apiName, openApiDocument, openApiUrl, development } = options;
  const { id = 'journeys', title = `${apiName} journeys` } = options.document ?? {};
  const problems: string[] = [];
  const workflows: { workflowId: string }[] = [];
  const expectations = new Map<string, unknown>();
  const differences: ReturnType<typeof compileJourney>['differences'] = [];
  const workflowIds = new Set<string>();
  const approvalIds = new Set<string>();
  for (const { arazzo } of entries.values()) {
    if (!Array.isArray(arazzo.workflows)) continue;
    for (const workflow of arazzo.workflows) {
      if (isObject(workflow) && typeof workflow.workflowId === 'string') workflowIds.add(workflow.workflowId);
    }
  }

  if (!documentId.test(id) || !title.trim() || entries.has(id)) {
    problems.push('The code journey document needs a unique, URL-safe ID and a title.');
  } else if (!openApiDocument) {
    problems.push('Code journeys require openApiDocument, the same document the application serves at openApiUrl.');
  } else {
    const operations = operationIds(openApiDocument);
    for (const journey of journeys) {
      try {
        if (workflowIds.has(journey.id)) throw new TypeError('Duplicate workflow ID.');
        const built = compileJourney(journey, operations);
        for (const { id } of built.differences) {
          if (approvalIds.has(id)) built.problems.push(`Duplicate approved difference ID "${id}".`);
        }
        if (built.problems.length) {
          problems.push(...built.problems.map(problem => `${journey.id}: ${problem}`));
          continue;
        }
        workflows.push(built.workflow);
        workflowIds.add(journey.id);
        expectations.set(journey.id, built.expectations);
        differences.push(...built.differences);
        for (const { id } of built.differences) approvalIds.add(id);
      } catch (error) {
        problems.push(`${journey.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  if (problems.length) {
    if (development) throw new TypeError(`Invalid Sendproof journeys:\n${problems.join('\n')}`);
    for (const problem of problems) console.warn(`Sendproof skipped a journey: ${problem}`);
  }
  if (!workflows.length) return;
  const words = apiName.match(/[A-Za-z0-9]+/g) ?? ['api'];
  const name = words.map((word, index) => (index === 0 ? word[0].toLowerCase() : word[0].toUpperCase()) + word.slice(1)).join('');
  entries.set(id, {
    source: 'code',
    arazzo: {
      arazzo: '1.1.0', info: { title, version: '1.0.0' },
      sourceDescriptions: [{ name, url: openApiUrl, type: 'openapi' }], workflows,
    },
    expectations: {
      sendproofExpectations: '1.0', arazzo: id + '.arazzo.json', journeys: Object.fromEntries(expectations),
      ...(differences.length ? { approvedDifferences: differences } : {}),
    },
  });
}

export function registerJourneys(journeys: readonly (string | URL | CodeJourney)[], options: CodeOptions) {
  const entries = new Map<string, Entry>();
  const code: CodeJourney[] = [];
  for (const journey of journeys) {
    if (typeof journey !== 'string' && !(journey instanceof URL)) {
      code.push(journey);
      continue;
    }
    const path = journey instanceof URL ? fileURLToPath(journey) : journey;
    const name = basename(path).match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\.arazzo\.json$/)?.[1];
    if (!name || entries.has(name)) throw new TypeError('Journey files need unique <name>.arazzo.json filenames.');
    const arazzo: ArazzoDocument = JSON.parse(readFileSync(path, 'utf8'));
    if (arazzo?.arazzo !== '1.1.0' || typeof arazzo.info?.title !== 'string' || !arazzo.info.title.trim()
        || !Array.isArray(arazzo.sourceDescriptions) || arazzo.sourceDescriptions.some(source => typeof source?.url !== 'string')) {
      throw new TypeError('Journey files need an Arazzo 1.1.0 title and source descriptions.');
    }
    const expectations = JSON.parse(readFileSync(path.replace(/\.arazzo\.json$/, '.expect.json'), 'utf8'));
    if (expectations?.sendproofExpectations !== '1.0' || expectations.arazzo !== name + '.arazzo.json') {
      throw new TypeError('Journey expectations must name the paired Arazzo file and use version 1.0.');
    }
    entries.set(name, { arazzo, expectations, source: 'file' });
  }
  if (code.length && options.enabled) registerCode(entries, code, options);

  return {
    get size() { return entries.size; },
    discover(basePath: string) {
      return Array.from(entries, ([name, { arazzo, source }]) => ({
        name: arazzo.info.title,
        source,
        arazzoUrl: basePath + journeyPrefix + name + '.arazzo.json',
        expectationsUrl: basePath + journeyPrefix + name + '.expect.json',
      }));
    },
    document(path: string, basePath: string) {
      const route = path.slice(journeyPrefix.length).match(/^([^/]+)\.(arazzo|expect)\.json$/);
      const entry = route && entries.get(route[1]);
      if (!entry) return undefined;
      if (route[2] === 'expect') return entry.expectations;
      const { arazzo } = entry;
      return {
        ...arazzo,
        sourceDescriptions: arazzo.sourceDescriptions.map(source => ({
          ...source, url: localPath(source.url) ? basePath + source.url : source.url,
        })),
      };
    },
  };
}
