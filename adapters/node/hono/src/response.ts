import type { TransportResponse } from '@test-bench/core';

/** Response statuses that must not carry a body. */
const bodyless = new Set([204, 205, 304]);

/** Marker header set by the internal router's not-found handler to tell "no such operation" from a handler's own 404. */
export const unmatchedHeader = 'x-testbench-unmatched';

/** Convert a protocol response from the core into a fetch `Response`. */
export function toResponse(answer: TransportResponse, method: string): Response {
  const headers = new Headers();
  for (const [name, value] of Object.entries(answer.headers)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, String(item));
  }
  const body = method === 'HEAD' || bodyless.has(answer.status) ? null : new Uint8Array(answer.body);
  return new Response(body, { status: answer.status, headers });
}

/**
 * Read a Preview response, abandoning the stream as soon as it exceeds `limit`
 * bytes so the remaining body is never buffered.
 */
export async function captureResponse(response: Response, limit: number): Promise<TransportResponse> {
  const headers = Object.fromEntries(response.headers);
  if (!response.body) return { status: response.status, headers, body: Buffer.alloc(0) };
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      void reader.cancel().catch(() => {});
      return { status: response.status, headers, body: Buffer.alloc(0), exceeded: true };
    }
    chunks.push(Buffer.from(value));
  }
  return { status: response.status, headers, body: Buffer.concat(chunks, size) };
}
