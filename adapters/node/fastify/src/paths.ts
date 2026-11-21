/**
 * OpenAPI path templates accepted by `operation`: literal segments or `{name}` parameters.
 * Wildcards, regex groups and optional markers are rejected so a template cannot widen the set of
 * URLs the workbench is allowed to dispatch to.
 */
const TEMPLATE = /^\/(?:[a-zA-Z0-9._~%-]+|\{[a-zA-Z_][a-zA-Z0-9_]*\})(?:\/(?:[a-zA-Z0-9._~%-]+|\{[a-zA-Z_][a-zA-Z0-9_]*\}))*$/;

/** HTTP methods an operation may be registered with, upper case as Fastify names them. */
export const OPERATION_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;

/** An upper-case HTTP method that Test Bench can exercise. */
export type OperationMethod = (typeof OPERATION_METHODS)[number];

/** Narrow a caller-supplied method name to a supported method, or `undefined`. */
export function operationMethod(method: string): OperationMethod | undefined {
  const verb = method.toUpperCase();
  return (OPERATION_METHODS as readonly string[]).includes(verb) ? (verb as OperationMethod) : undefined;
}

/**
 * Convert an OpenAPI template such as `/items/{id}` to a Fastify route URL (`/items/:id`).
 *
 * @throws TypeError when the template is not a plain OpenAPI path, contains dot segments, or
 * targets the reserved `/bench` namespace.
 */
export function routePath(template: string): string {
  if (!TEMPLATE.test(template) ||
    template.split('/').some(segment => segment === '.' || segment === '..') ||
    /^\/bench(?:\/|$)/i.test(template)) {
    throw new TypeError('Use an OpenAPI route template such as /items/{id}.');
  }
  return template.replace(/\{([^{}]+)\}/g, ':$1');
}
