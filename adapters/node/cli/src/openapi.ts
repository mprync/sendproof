// Reading an OpenAPI document the way the workbench does: local references only, path-level
// parameters merged with operation-level ones, one entry per method and path.
//
// Not swapped for a library (@redocly/openapi-core, @apidevtools/json-schema-ref-parser): every
// document here is one in-memory object with only local #/... refs, so a library built for
// resolving and bundling multi-file or remote refs solves a problem this package doesn't have,
// and its "dereference" fully resolves $ref nodes away — which would break compactSchema's and
// describe_model's deliberate "$ref": "Name" markers (so an agent sees a model once, not inlined
// at every use) and the describe_model "usedBy" search, which looks for that same marker.

export type Json = null | boolean | number | string | Json[] | JsonObject;
/** Undefined members are allowed so optional fields can be left out; JSON.stringify drops them. */
export type JsonObject = { [key: string]: Json | undefined };

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

export interface Parameter {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  required: boolean;
  description?: string;
  schema?: JsonObject;
  style?: string;
  explode?: boolean;
  example?: Json;
}

export interface Operation {
  /** The operationId, or METHOD path when the document gives none. */
  id: string;
  method: string;
  path: string;
  summary: string;
  description?: string;
  tag: string;
  deprecated: boolean;
  secured: boolean;
  parameters: Parameter[];
  operation: JsonObject;
  /** The OpenAPI document this operation came from, by name. */
  document: string;
}

const isObject = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Resolves a local `#/...` reference; anything else is returned as it is. */
export function dereference(value: Json | undefined, document: JsonObject): Json | undefined {
  if (!isObject(value) || typeof value.$ref !== 'string' || !value.$ref.startsWith('#/')) return value;
  let node: Json | undefined = document;
  for (const raw of value.$ref.slice(2).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    node = isObject(node) && Object.hasOwn(node, key) ? node[key] : undefined;
  }
  return node;
}

/** The component name a `#/components/schemas/Name` reference points to. */
export const refName = (ref: string) => ref.startsWith('#/components/schemas/') ? decodeURIComponent(ref.slice(21)).replace(/~1/g, '/').replace(/~0/g, '~') : ref;

export function operations(document: JsonObject, documentName: string): Operation[] {
  const found: Operation[] = [];
  const globalSecurity = Array.isArray(document.security) && document.security.length > 0;
  const paths = isObject(document.paths) ? document.paths : {};
  for (const [path, rawItem] of Object.entries(paths)) {
    const item = dereference(rawItem, document);
    if (!isObject(item)) continue;
    for (const verb of METHODS) {
      const operation = item[verb];
      if (!isObject(operation)) continue;
      const merged = new Map<string, Parameter>();
      for (const raw of [...(Array.isArray(item.parameters) ? item.parameters : []), ...(Array.isArray(operation.parameters) ? operation.parameters : [])]) {
        const parameter = dereference(raw, document);
        if (!isObject(parameter) || typeof parameter.name !== 'string' || typeof parameter.in !== 'string') continue;
        merged.set(`${parameter.in}:${parameter.name}`, {
          name: parameter.name,
          in: parameter.in as Parameter['in'],
          required: parameter.required === true || parameter.in === 'path',
          description: typeof parameter.description === 'string' ? parameter.description : undefined,
          schema: isObject(parameter.schema) ? parameter.schema : undefined,
          style: typeof parameter.style === 'string' ? parameter.style : undefined,
          explode: typeof parameter.explode === 'boolean' ? parameter.explode : undefined,
          example: parameter.example,
        });
      }
      const method = verb.toUpperCase();
      const security = Array.isArray(operation.security) ? operation.security.length > 0 : globalSecurity;
      found.push({
        id: typeof operation.operationId === 'string' ? operation.operationId : `${method} ${path}`,
        method, path,
        summary: typeof operation.summary === 'string' ? operation.summary : '',
        description: typeof operation.description === 'string' ? operation.description : undefined,
        tag: Array.isArray(operation.tags) && typeof operation.tags[0] === 'string' ? operation.tags[0] : 'Operations',
        deprecated: operation.deprecated === true,
        secured: security,
        parameters: [...merged.values()],
        operation,
        document: documentName,
      });
    }
  }
  return found;
}

/**
 * A schema for an agent to read: references to named components stay as `{ "$ref": "Name" }` so a
 * large model is described once (describe_model), and inline schemas are kept to a depth.
 */
export function compactSchema(schema: Json | undefined, document: JsonObject, depth = 4): Json | undefined {
  if (!isObject(schema)) return schema;
  if (typeof schema.$ref === 'string') {
    if (schema.$ref.startsWith('#/components/schemas/')) return { $ref: refName(schema.$ref) };
    return compactSchema(dereference(schema, document), document, depth);
  }
  if (depth <= 0) return { type: schema.type ?? 'object', description: '(nested schema omitted)' };
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'properties' && isObject(value)) {
      out.properties = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, compactSchema(child, document, depth - 1) ?? null]));
    } else if ((key === 'items' || key === 'additionalProperties' || key === 'not') && isObject(value)) {
      out[key] = compactSchema(value, document, depth - 1) ?? null;
    } else if ((key === 'oneOf' || key === 'anyOf' || key === 'allOf') && Array.isArray(value)) {
      out[key] = value.map(child => compactSchema(child, document, depth - 1) ?? null);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** The request body's media types and their schemas. */
export function requestBody(op: Operation, document: JsonObject) {
  const body = dereference(op.operation.requestBody, document);
  if (!isObject(body) || !isObject(body.content)) return undefined;
  return {
    required: body.required === true,
    description: typeof body.description === 'string' ? body.description : undefined,
    content: Object.fromEntries(Object.entries(body.content).map(([type, media]) => [type, {
      schema: isObject(media) ? compactSchema(media.schema, document) ?? null : null,
      ...(isObject(media) && media.example !== undefined ? { example: media.example } : {}),
    }])),
  };
}

export function responses(op: Operation, document: JsonObject) {
  const all = isObject(op.operation.responses) ? op.operation.responses : {};
  return Object.entries(all).map(([status, raw]) => {
    const response = dereference(raw, document);
    const content = isObject(response) && isObject(response.content) ? response.content : {};
    const [type, media] = Object.entries(content)[0] ?? [];
    return {
      status,
      description: isObject(response) && typeof response.description === 'string' ? response.description : '',
      ...(type ? { contentType: type, schema: isObject(media) ? compactSchema(media.schema, document, 2) ?? null : null } : {}),
    };
  });
}

/** The first JSON-ish media type of a request body, used when the caller gives none. */
export function defaultMediaType(op: Operation, document: JsonObject): string | undefined {
  const body = dereference(op.operation.requestBody, document);
  if (!isObject(body) || !isObject(body.content)) return undefined;
  const types = Object.keys(body.content);
  return types.find(type => /json/i.test(type)) ?? types[0];
}

/**
 * Finds the schema at a field path inside a schema: `customerId`, `lines[].variantId` or
 * `lines.0.variantId`. Walks references, `allOf` and arrays.
 */
export function schemaAt(schema: Json | undefined, path: string, document: JsonObject): JsonObject | undefined {
  let node = resolveSchema(schema, document);
  const parts = path.replace(/\[\d*\]/g, '.[]').split('.').filter(Boolean);
  for (const part of parts) {
    if (!node) return undefined;
    if (part === '[]' || /^\d+$/.test(part)) { node = resolveSchema(node.items, document); continue; }
    node = resolveSchema(propertyOf(node, part, document), document);
  }
  return node;
}

function propertyOf(schema: JsonObject, name: string, document: JsonObject): Json | undefined {
  if (isObject(schema.properties) && Object.hasOwn(schema.properties, name)) return schema.properties[name];
  for (const key of ['allOf', 'oneOf', 'anyOf'] as const) {
    const list = schema[key];
    if (!Array.isArray(list)) continue;
    for (const child of list) {
      const resolved = resolveSchema(child, document);
      const found = resolved && propertyOf(resolved, name, document);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function resolveSchema(schema: Json | undefined, document: JsonObject, seen = 0): JsonObject | undefined {
  const resolved = dereference(schema, document);
  if (!isObject(resolved)) return undefined;
  if (typeof resolved.$ref === 'string' && seen < 16) return resolveSchema(resolved, document, seen + 1);
  return resolved;
}

export const isJsonObject = isObject;
