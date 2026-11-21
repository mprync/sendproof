import { SetMetadata } from '@nestjs/common';

/** A controller action that may run in a rollback Preview and as an observed Send. */
export interface PreviewOperation {
  method: string;
  path: string;
}

/** Metadata key under which {@link SendproofPreview} records its operation. */
export const previewKey = Symbol('Sendproof preview operation');

const ordinaryVerbs = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

/**
 * Declare one controller action eligible for Preview and observed Send.
 *
 * `path` is the workbench-relative OpenAPI template (for example `/items/{id}`),
 * without the global prefix configured through `basePath`.
 */
export function SendproofPreview(method: string, path: string): MethodDecorator {
  const verb = method.toUpperCase();
  if (!ordinaryVerbs.has(verb) || !path.startsWith('/') || /[?#\\]/.test(path) || path.startsWith('//')) {
    throw new TypeError('Supply an HTTP method and the workbench-relative OpenAPI path template.');
  }
  const operation: PreviewOperation = { method: verb, path };
  return SetMetadata(previewKey, operation);
}

/** Read the operation recorded on a controller method, if any. */
export function previewOperation(handler: unknown): PreviewOperation | undefined {
  return typeof handler === 'function' ? Reflect.getMetadata(previewKey, handler) : undefined;
}
