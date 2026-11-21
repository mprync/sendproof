/**
 * Path validation shared by the Hono router: OpenAPI route templates are
 * converted to Hono patterns, and the mount prefix is checked before use.
 */

const segment = String.raw`(?:[a-zA-Z0-9._~%-]+|\{[a-zA-Z_][a-zA-Z0-9_]*\})`;
const templatePattern = new RegExp(String.raw`^/${segment}(?:/${segment})*$`);
const basePathPattern = /^\/[a-zA-Z0-9._~-]+(?:\/[a-zA-Z0-9._~-]+)*$/;

/** Reject `.` and `..` segments, which would let a template escape its mount. */
const hasDotSegment = (path: string): boolean => path.split('/').some(part => part === '.' || part === '..');

/**
 * Convert an OpenAPI template such as `/items/{id}` to a Hono pattern such as
 * `/items/:id`. The reserved `/sendproof` namespace cannot be registered.
 */
export function routePath(template: string): string {
  if (!templatePattern.test(template) || hasDotSegment(template) || /^\/sendproof(?:\/|$)/i.test(template)) {
    throw new TypeError('Use an OpenAPI route template such as /items/{id}.');
  }
  return template.replace(/\{([^{}]+)\}/g, ':$1');
}

/** Validate the optional mount prefix; the empty string means the router is mounted at the root. */
export function assertBasePath(basePath: string): void {
  if (basePath && (!basePathPattern.test(basePath) || hasDotSegment(basePath))) {
    throw new TypeError('basePath must be an absolute path without a trailing slash.');
  }
}
