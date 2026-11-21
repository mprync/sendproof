import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { createBench } from '@sendproof/core';
import { captureResponse, observeResponse, sendResponse } from '@sendproof/core/node-http';
import { requestContext } from './context.js';
import { expressPath, operationVerb } from './paths.js';
import type { ExpressBenchOptions, SendproofMiddleware } from './types.js';

export type { ExpressBenchOptions, SendproofMiddleware } from './types.js';

/** Registered operation, as advertised in the capabilities document. */
interface Operation {
  method: string;
  path: string;
}

/**
 * Mount the workbench and register the same route handlers for both Send and Preview.
 *
 * The returned middleware serves the UI and protocol under `/sendproof/`. Operations registered with
 * `.operation()` live on an internal router that the middleware dispatches to directly for
 * Preview and that falls through to for ordinary (and observed) Send requests.
 */
export function sendproof(options: ExpressBenchOptions = {}): SendproofMiddleware {
  const router = Router({ caseSensitive: true, mergeParams: true, strict: true });
  const operations: Operation[] = [];
  // Responses created for an in-process preview dispatch; their routes must not start a second observation.
  const internal = new WeakSet<Response>();
  const bench = createBench<Request>(options, () => operations);

  const middleware = (async (req: Request, res: Response, next: NextFunction) => {
    const context = requestContext(req);
    const answer = await bench.lookup(context);
    if (!answer) return router(req, res, next);
    if ('target' in answer) {
      const rendered = await bench.preview(context, () => captureResponse(
        (request, response, done) => {
          internal.add(response);
          router(request, response, done);
        }, req, res, answer.target, bench.maxResponseBytes,
      ));
      return sendResponse(req, res, rendered);
    }
    return sendResponse(req, res, answer);
  }) as SendproofMiddleware;

  middleware.operation = (method, template, ...handlers) => {
    const verb = operationVerb(method);
    if (!verb || !handlers.length) {
      throw new TypeError('Choose a supported HTTP method and supply the route handler.');
    }
    if (operations.some(entry => entry.method === verb.toUpperCase() && entry.path === template)) {
      throw new TypeError('This operation is already registered.');
    }
    router[verb](expressPath(template), async (req: Request, res: Response, forward: NextFunction) => {
      if (internal.has(res) || req.method !== verb.toUpperCase()) return forward();
      const observed = await bench.observation(requestContext(req));
      if (!observed) return forward();
      observeResponse(res, observed);
      return observed.run(forward);
    }, ...handlers);
    operations.push({ method: verb.toUpperCase(), path: template });
    return middleware;
  };

  return middleware;
}
