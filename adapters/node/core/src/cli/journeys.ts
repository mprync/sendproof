// Journeys an API publishes (docs/plans/journeys.md): capabilities list Arazzo documents and their
// expectations documents. This reads and describes them; running them needs Preview sessions,
// which the adapters add with the journeys feature.

import type { SendproofClient } from './client.js';
import { isJsonObject, type Json, type JsonObject } from './openapi.js';

export interface JourneySource { name: string; arazzoUrl: string; expectationsUrl?: string; source: 'code' | 'file' }

export function journeySources(caps: JsonObject): JourneySource[] {
  if (!Array.isArray(caps.journeys)) return [];
  return caps.journeys.filter(isJsonObject).filter(j => typeof j.arazzoUrl === 'string').map(j => ({
    name: String(j.name ?? 'Journeys'), arazzoUrl: String(j.arazzoUrl),
    expectationsUrl: typeof j.expectationsUrl === 'string' ? j.expectationsUrl : undefined,
    source: j.source === 'file' ? 'file' : 'code',
  }));
}

async function readDocument(client: SendproofClient, path: string): Promise<JsonObject> {
  const response = await client.request(client.hostUrl(path), { headers: { Accept: 'application/json' } });
  const text = await response.text();
  let body: Json | undefined;
  try { body = text ? JSON.parse(text) as Json : undefined; } catch { body = undefined; }
  if (!response.ok || !isJsonObject(body)) throw new Error(`Couldn’t read ${path} (HTTP ${response.status}).`);
  return body;
}

export async function loadJourneys(client: SendproofClient) {
  const caps = await client.capabilities();
  const loaded = [];
  for (const source of journeySources(caps)) {
    const arazzo = await readDocument(client, source.arazzoUrl);
    const expectations = source.expectationsUrl ? await readDocument(client, source.expectationsUrl).catch(() => undefined) : undefined;
    loaded.push({ source, arazzo, expectations });
  }
  return loaded;
}

export async function listJourneys(client: SendproofClient) {
  const journeys = [];
  for (const { source, arazzo } of await loadJourneys(client)) {
    for (const workflow of Array.isArray(arazzo.workflows) ? arazzo.workflows.filter(isJsonObject) : []) {
      const steps = Array.isArray(workflow.steps) ? workflow.steps.filter(isJsonObject) : [];
      journeys.push({
        journeyId: String(workflow.workflowId),
        name: String(workflow.summary ?? workflow.workflowId),
        description: typeof workflow.description === 'string' ? workflow.description : undefined,
        document: source.name,
        steps: steps.length,
        operations: steps.map(step => String(step.operationId ?? step.operationPath ?? step.workflowId ?? '')),
      });
    }
  }
  return journeys;
}

/** Finds one journey's raw Arazzo workflow and its expectations document, across every source
 *  the capabilities list, for both describing a journey and running it (journeys-run.ts). */
export async function locateJourney(client: SendproofClient, journeyId: string) {
  for (const { source, arazzo, expectations } of await loadJourneys(client)) {
    const workflow = (Array.isArray(arazzo.workflows) ? arazzo.workflows.filter(isJsonObject) : []).find(w => w.workflowId === journeyId);
    if (workflow) return { source, workflow, expectations: expectations ?? {} };
  }
  return undefined;
}

export async function describeJourney(client: SendproofClient, journeyId: string) {
  const located = await locateJourney(client, journeyId);
  if (located) {
    const { source, workflow, expectations } = located;
    const expected = isJsonObject(expectations.journeys) && isJsonObject(expectations.journeys[journeyId]) ? expectations.journeys[journeyId] : undefined;
    const stepExpectations = isJsonObject(expected?.steps) ? expected.steps : {};
    const approved = Array.isArray(expectations.approvedDifferences)
      ? expectations.approvedDifferences.filter(isJsonObject).filter(a => a.journey === journeyId) : [];
    return {
      journeyId,
      name: String(workflow.summary ?? journeyId),
      description: typeof workflow.description === 'string' ? workflow.description : undefined,
      document: source.name,
      inputs: workflow.inputs ?? null,
      steps: (Array.isArray(workflow.steps) ? workflow.steps.filter(isJsonObject) : []).map(step => ({
        stepId: String(step.stepId),
        operationId: step.operationId ?? null,
        description: typeof step.description === 'string' ? step.description : undefined,
        parameters: step.parameters ?? [],
        requestBody: step.requestBody ?? null,
        successCriteria: step.successCriteria ?? [],
        outputs: step.outputs ?? {},
        expected: stepExpectations[String(step.stepId)] ?? null,
      })),
      outputs: workflow.outputs ?? {},
      approvedDifferences: approved,
      group: typeof expected?.group === 'string' ? expected.group : null,
      runAs: typeof expected?.runAs === 'string' ? expected.runAs : null,
      sendOnly: expected?.sendOnly === true,
      sendOnlyReason: typeof expected?.sendOnlyReason === 'string' ? expected.sendOnlyReason : null,
    };
  }
  throw new Error(`No journey “${journeyId}”. Call list_journeys to see them.`);
}
