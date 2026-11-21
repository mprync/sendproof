import type { FastifyReply, FastifyRequest } from 'fastify';
import type { BenchRequest, TransportResponse } from '@sendproof/core';

/**
 * Describe a Fastify request for the protocol core. `pathname` has the plugin's prefix removed so
 * the core always sees `/sendproof/...`; `basePath` is that prefix, used to build discovery URLs.
 */
export function requestContext(request: FastifyRequest, basePath: string): BenchRequest<FastifyRequest> {
  const url = request.raw.url ?? '/';
  const at = url.indexOf('?');
  const path = at < 0 ? url : url.slice(0, at);
  return {
    method: request.method,
    pathname: path.slice(basePath.length) || '/',
    query: at < 0 ? '' : url.slice(at),
    basePath,
    origin: `${request.protocol}://${request.headers.host}`,
    headers: request.headers,
    raw: request,
  };
}

/** Write a core-generated response directly to the raw Node response (the reply is hijacked). */
export function sendTransport(reply: FastifyReply, response: TransportResponse, method: string): void {
  reply.raw.statusCode = response.status;
  for (const [name, value] of Object.entries(response.headers)) {
    if (value !== undefined) reply.raw.setHeader(name, value);
  }
  reply.raw.end(method === 'HEAD' ? undefined : response.body);
}
