import { ServerResponse } from 'node:http';
import type { IncomingMessage, OutgoingHttpHeaders } from 'node:http';
import type { FastifyInstance } from 'fastify';
import type { TransportResponse } from '@sendproof/core';

type WriteCallback = (error?: Error | null) => void;

/** Outcome of an in-process dispatch: a captured response, or a marker that no eligible route matched. */
export type DispatchResult = TransportResponse | { unmatched: true };

/** Requests being dispatched in-process, so the plugin hooks can tell them from real traffic. */
export const dispatching = new WeakSet<IncomingMessage>();

/** Responses whose route was a registered Sendproof operation. */
export const matchedResponses = new WeakSet<ServerResponse>();

/**
 * Dispatch through Fastify's router without a socket, keeping at most `limit` response bytes.
 *
 * The request is re-pointed at `target` for the duration of the call and restored afterwards.
 * Exceeding the limit settles immediately with `exceeded: true` and an empty body, so a streaming
 * handler is told the connection closed rather than being buffered indefinitely.
 */
export function dispatchInProcess(
  app: FastifyInstance, request: IncomingMessage, target: string, limit: number,
): Promise<DispatchResult> {
  const originalUrl = request.url;
  const response = new ServerResponse(request);
  const buffers: Buffer[] = [];
  let size = 0;
  let settled = false;
  request.url = target;
  dispatching.add(request);

  return new Promise<DispatchResult>((resolve, reject) => {
    const finish = (error: unknown, value?: DispatchResult): void => {
      if (settled) return;
      settled = true;
      request.url = originalUrl;
      dispatching.delete(request);
      if (error) reject(error); else resolve(value as DispatchResult);
    };
    const snapshot = (exceeded: boolean): DispatchResult => !matchedResponses.has(response) ? { unmatched: true } : {
      status: response.statusCode,
      headers: response.getHeaders(),
      body: exceeded ? Buffer.alloc(0) : Buffer.concat(buffers, size),
      exceeded,
    };

    response.writeHead = ((status: number, message?: string | OutgoingHttpHeaders, headers?: OutgoingHttpHeaders) => {
      response.statusCode = status;
      const values = typeof message === 'string' ? headers : message;
      if (values) {
        for (const [name, value] of Object.entries(values)) {
          if (value !== undefined) response.setHeader(name, value);
        }
      }
      return response;
    }) as ServerResponse['writeHead'];

    response.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding | WriteCallback, callback?: WriteCallback) => {
      if (settled) return false;
      const charset = typeof encoding === 'string' ? encoding : undefined;
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk, charset) : Buffer.from(chunk);
      size += bytes.length;
      const complete = typeof encoding === 'function' ? encoding : callback;
      if (size > limit) {
        finish(null, snapshot(true));
        response.emit('close');
        if (complete) queueMicrotask(complete);
        return false;
      }
      buffers.push(bytes);
      if (complete) queueMicrotask(complete);
      return true;
    }) as ServerResponse['write'];

    response.end = ((chunk?: unknown, encoding?: unknown, callback?: unknown) => {
      if (settled) return response;
      if (chunk != null && typeof chunk !== 'function') {
        response.write(chunk as string | Uint8Array, encoding as BufferEncoding);
      }
      if (settled) return response;
      response.finished = true;
      const complete = [callback, encoding, chunk].find((value): value is () => void => typeof value === 'function');
      finish(null, snapshot(false));
      response.emit('finish');
      complete?.();
      return response;
    }) as ServerResponse['end'];

    response.once('error', error => finish(error));
    try {
      app.routing(request, response);
    } catch (error) {
      finish(error);
    }
  });
}
