/**
 * OpenAPI path templates accepted by `operation`: literal segments or `{name}` parameters.
 * Everything else (wildcards, regex groups, optional markers) is rejected so a template can never
 * widen the set of URLs the workbench is allowed to dispatch to.
 */
const TEMPLATE = /^\/(?:[a-zA-Z0-9._~%-]+|\{[a-zA-Z_][a-zA-Z0-9_]*\})(?:\/(?:[a-zA-Z0-9._~%-]+|\{[a-zA-Z_][a-zA-Z0-9_]*\}))*$/;

/** HTTP methods an operation may be registered with, in lower case as Express names them. */
export const OPERATION_VERBS = ['get', 'post', 'put', 'patch', 'delete', 'options'] as const;

/** A lower-case Express router verb that Test Bench can exercise. */
export type OperationVerb = (typeof OPERATION_VERBS)[number];

/** Narrow a caller-supplied method name to a supported router verb, or `undefined`. */
export function operationVerb(method: string): OperationVerb | undefined {
  const verb = method.toLowerCase();
  return (OPERATION_VERBS as readonly string[]).includes(verb) ? (verb as OperationVerb) : undefined;
}

/**
 * Convert an OpenAPI template such as `/items/{id}` to an Express 5 path (`/items/:id`).
 *
 * @throws TypeError when the template is not a plain OpenAPI path, contains dot segments, or
 * targets the reserved `/bench` namespace.
 */
export function expressPath(template: string): string {
  if (!TEMPLATE.test(template) ||
    template.split('/').some(segment => segment === '.' || segment === '..') ||
    /^\/bench(?:\/|$)/i.test(template)) {
    throw new TypeError('Use an OpenAPI route template such as /items/{id}.');
  }
  return template.replace(/\{([^{}]+)\}/g, ':$1');
}
