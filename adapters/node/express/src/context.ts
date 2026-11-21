import type { Request } from 'express';
import type { BenchRequest } from '@test-bench/core';

/**
 * Describe an Express request for the protocol core. `pathname` is relative to the router the
 * middleware is mounted on, and `basePath` is that mount point, so discovery URLs stay correct
 * when the bench lives under `app.use('/api', ...)`.
 */
export function requestContext(req: Request): BenchRequest<Request> {
  const queryAt = req.url.indexOf('?');
  return {
    method: req.method,
    pathname: queryAt < 0 ? req.url : req.url.slice(0, queryAt),
    query: queryAt < 0 ? '' : req.url.slice(queryAt),
    basePath: req.baseUrl ?? '',
    origin: `${req.protocol}://${req.get('host')}`,
    headers: req.headers,
    raw: req,
  };
}
