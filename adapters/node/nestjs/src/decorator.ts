import { SetMetadata } from '@nestjs/common';
import { unavailableOperation } from '@sendproof/core';
import type { UnavailableOptions } from '@sendproof/core';

/** A controller action that may run in a rollback Preview and as an observed Send. */
export interface PreviewOperation {
  method: string;
  path: string;
  /** False for an action marked `preview: false`; it is listed in `previewUnavailable` instead. */
  enabled?: false;
  reason?: string;
  stores?: string[];
}

/** Options of {@link SendproofPreview}. `enabled: false` marks the action `preview: false`. */
export interface SendproofPreviewOptions extends UnavailableOptions {
  /** Set to false for an action that writes to a guarded store such as Redis. */
  enabled?: boolean;
}

/** Metadata key under which {@link SendproofPreview} records its operation. */
export const previewKey = Symbol('Sendproof preview operation');

const ordinaryVerbs = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

/**
 * Declare one controller action eligible for Preview and observed Send.
 *
 * `path` is the workbench-relative OpenAPI template (for example `/items/{id}`),
 * without the global prefix configured through `basePath`. With `{ enabled: false, reason }` the
 * action is marked `preview: false` instead: Send runs it, capabilities list it in
 * `previewUnavailable` with the reason, and a Preview of it answers 409 without running it.
 */
export function SendproofPreview(method: string, path: string, options: SendproofPreviewOptions = {}): MethodDecorator {
  const verb = method.toUpperCase();
  if (!ordinaryVerbs.has(verb) || !path.startsWith('/') || /[?#\\]/.test(path) || path.startsWith('//')) {
    throw new TypeError('Supply an HTTP method and the workbench-relative OpenAPI path template.');
  }
  if (options.enabled !== undefined && typeof options.enabled !== 'boolean') throw new TypeError('enabled must be a boolean.');
  const operation: PreviewOperation = options.enabled === false
    ? { ...unavailableOperation(verb, path, options), enabled: false }
    : { method: verb, path };
  return SetMetadata(previewKey, operation);
}

/** Read the operation recorded on a controller method, if any. */
export function previewOperation(handler: unknown): PreviewOperation | undefined {
  return typeof handler === 'function' ? Reflect.getMetadata(previewKey, handler) : undefined;
}
