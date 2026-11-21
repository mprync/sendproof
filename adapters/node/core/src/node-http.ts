import type { IncomingMessage } from 'node:http';
import type { DispatchResponse, Observation, TransportResponse } from './types.js';
import { ServerResponse } from 'node:http';

interface CapturedRequest extends IncomingMessage {
  originalUrl: string;
  res?: ServerResponse;
  params?: unknown;
  route?: unknown;
  baseUrl?: string;
}

interface CapturedResponse extends ServerResponse {
  locals?: Record<string, unknown>;
}

type Completion = (error?: Error | null) => void;

/** Execute an in-process Node request against a bounded, socket-free response. */
export function captureResponse<Request extends CapturedRequest, Response extends CapturedResponse>(
  router: (request: Request, response: Response, done: (error?: unknown) => void) => void,
  req: Request,
  original: Response,
  target: string,
  limit: number,
  originalUrl = (req.baseUrl ?? '') + target,
): Promise<DispatchResponse> {
  const response = Object.setPrototypeOf(new ServerResponse(req), Object.getPrototypeOf(original)) as unknown as Response;
  const originalRequest = {
    url: req.url, originalUrl: req.originalUrl, res: req.res,
    params: req.params, route: req.route, baseUrl: req.baseUrl,
  };
  response.locals = Object.assign(Object.create(null), original.locals);
  req.url = target;
  req.originalUrl = originalUrl;
  req.res = response;

  let size = 0;
  let settled = false;
  const buffers: Buffer[] = [];
  return new Promise((resolve, reject) => {
    const interrupted = () => {
      finish(new Error('The client disconnected during preview.'));
      response.emit('close');
    };
    const finish = (error?: unknown, result?: DispatchResponse) => {
      if (settled) return;
      settled = true;
      original.off('close', interrupted);
      Object.assign(req, originalRequest);
      if (error) reject(error);
      else resolve(result ?? { unmatched: true });
    };

    original.once('close', interrupted);
    const snapshot = (exceeded: boolean): TransportResponse => ({
      status: response.statusCode, headers: response.getHeaders(),
      body: exceeded ? Buffer.alloc(0) : Buffer.concat(buffers, size),
      exceeded,
    });
    response.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding | Completion, callback?: Completion) => {
      if (settled) return false;
      const complete = typeof encoding === 'function' ? encoding : callback;
      const charset = typeof encoding === 'string' ? encoding : undefined;
      size += Buffer.byteLength(chunk, charset);
      if (size > limit) {
        finish(null, snapshot(true));
        response.emit('close');
        if (complete) queueMicrotask(complete);
        return false;
      }
      buffers.push(typeof chunk === 'string' ? Buffer.from(chunk, charset) : Buffer.from(chunk));
      if (complete) queueMicrotask(complete);
      return true;
    }) as Response['write'];
    Reflect.set(response, 'end', (chunk?: string | Uint8Array | Completion, encoding?: BufferEncoding | Completion, callback?: Completion) => {
      if (settled) return response;
      if (chunk != null && typeof chunk !== 'function') {
        if (typeof encoding === 'string') response.write(chunk, encoding);
        else response.write(chunk);
      }
      if (settled) return response;
      response.finished = true;
      const complete = [callback, encoding, chunk].find(value => typeof value === 'function');
      finish(null, snapshot(false));
      response.emit('finish');
      complete?.();
      return response;
    });
    response.flushHeaders = () => { response.writeHead(response.statusCode); };
    response.once('error', finish);
    try {
      router(req, response, error => finish(error, { unmatched: true }));
    } catch (error) {
      finish(error);
    }
  });
}

export function sendResponse<Response extends ServerResponse>(req: IncomingMessage, res: Response,
  { status, headers, body }: TransportResponse): Response {
  res.statusCode = status;
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) res.setHeader(name, value);
  }
  return res.end(req.method === 'HEAD' ? undefined : body);
}

/** Assign the trace header before the real Node response sends its headers. */
export function observeResponse(res: ServerResponse, observation: Observation) {
  const writeHead = res.writeHead;
  res.writeHead = function (this: ServerResponse, status: number, ...arguments_: unknown[]) {
    res.writeHead = writeHead;
    const trace = observation.complete(status);
    if (trace) res.setHeader('X-TestBench-Trace', trace);
    return Reflect.apply(writeHead, this, [status, ...arguments_]);
  } as ServerResponse['writeHead'];
}
