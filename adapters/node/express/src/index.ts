import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { createBench, unavailableOperation } from '@sendproof/core';
import type { RegisteredOperation, UnavailableOptions } from '@sendproof/core';
import { captureResponse, observeResponse, sendResponse } from '@sendproof/core/node-http';
import { requestContext } from './context.js';
import { expressPath, operationVerb } from './paths.js';
import type { ExpressBenchOptions, SendproofMiddleware } from './types.js';

export type { ExpressBenchOptions, SendproofMiddleware } from './types.js';

/**
 * Mount the workbench and register the same route handlers for both Send and Preview.
 *
 * The returned middleware serves the UI and protocol under `/sendproof/`. Operations registered with
 * `.operation()` live on an internal router that the middleware dispatches to directly for
 * Preview and that falls through to for ordinary (and observed) Send requests.
 */
export function sendproof(options: ExpressBenchOptions = {}): SendproofMiddleware {
  const router = Router({ caseSensitive: true, mergeParams: true, strict: true });
  const operations: RegisteredOperation[] = [];
  // Responses created for an in-process preview dispatch; their routes must not start a second observation.
  const internal = new WeakSet<Response>();
  const bench = createBench<Request>(options, () => operations, { language: 'node', framework: 'Express' });

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

  /** Validate a registration and return its router verb. */
  const register = (method: string, template: string, handlers: unknown[]) => {
    const verb = operationVerb(method);
    if (!verb || !handlers.length) {
      throw new TypeError('Choose a supported HTTP method and supply the route handler.');
    }
    if (operations.some(entry => entry.method === verb.toUpperCase() && entry.path === template)) {
      throw new TypeError('This operation is already registered.');
    }
    return verb;
  };

  middleware.unavailable = (method, template, options: UnavailableOptions, ...handlers) => {
    const verb = register(method, template, handlers);
    const entry = unavailableOperation(verb.toUpperCase(), template, options);
    // An ordinary route: Send runs it, and a Preview dispatch skips it, so the Preview finds no
    // operation and answers 409 without running the handler.
    router[verb](expressPath(template), (req: Request, res: Response, forward: NextFunction) => {
      if (internal.has(res)) return forward('route');
      return forward();
    }, ...handlers);
    operations.push({ ...entry, preview: false });
    return middleware;
  };

  middleware.operation = (method, template, ...handlers) => {
    const verb = register(method, template, handlers);
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
