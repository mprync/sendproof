import { Hono } from 'hono';
import type { Context, Env, Handler, MiddlewareHandler } from 'hono';
import { createBench, unavailableOperation } from '@sendproof/core';
import type { BenchOptions, BenchRequest, RegisteredOperation, UnavailableOptions } from '@sendproof/core';
import { assertBasePath, routePath } from './paths.js';
import { captureResponse, toResponse, unmatchedHeader } from './response.js';

export type SendproofOptions<E extends Env = Env> = BenchOptions<Context<E>> & {
  /** Path on the parent app where this router is mounted, without a trailing slash. */
  basePath?: string;
};

/** A Hono route handler or middleware, as accepted by `app.get(path, …)`. */
export type OperationHandler<E extends Env = Env> = Handler<E> | MiddlewareHandler<E>;

export type SendproofRouter<E extends Env = Env> = Hono<E> & {
  /** Register the same Hono handlers for Send and rollback Preview. */
  operation(method: string, template: string, ...handlers: OperationHandler<E>[]): SendproofRouter<E>;
  /**
   * Register handlers for an operation marked `preview: false`, for one that writes to a guarded
   * store such as Redis. Send runs them; capabilities list it in `previewUnavailable` with the
   * reason, and a Preview of it answers 409 without running them.
   */
  unavailable(method: string, template: string, options: UnavailableOptions, ...handlers: OperationHandler<E>[]): SendproofRouter<E>;
};

const operationMethods = new Set(['get', 'post', 'put', 'patch', 'delete', 'options']);

/** Describe a Hono request in the framework-neutral shape the core protocol expects. */
function describe<E extends Env>(c: Context<E>, basePath: string): BenchRequest<Context<E>> {
  const url = new URL(c.req.url);
  return {
    method: c.req.method,
    pathname: url.pathname.slice(basePath.length),
    query: url.search,
    basePath,
    origin: url.origin,
    headers: Object.fromEntries(c.req.raw.headers),
    raw: c,
  };
}

/**
 * Create a Hono router that serves the workbench and carries explicitly
 * registered previewable operations. Mount it on the application with
 * `app.route(basePath || '/', router)`.
 */
export function sendproof<E extends Env = Env>(options: SendproofOptions<E> = {}): SendproofRouter<E> {
  const { basePath = '', ...benchOptions } = options;
  assertBasePath(basePath);

  const app = new Hono<E>({ strict: true }) as SendproofRouter<E>;
  // Preview dispatches into this second router so a handler runs without the workbench gate in front of it.
  const internal = new Hono<E>({ strict: true });
  const operations: RegisteredOperation[] = [];
  const bench = createBench<Context<E>>(benchOptions, () => operations);

  app.use('*', async (c, next) => {
    const request = describe(c, basePath);
    const answer = await bench.lookup(request);
    if (!answer) return next();
    if (!('target' in answer)) return toResponse(answer, c.req.method);

    const rendered = await bench.preview(request, async () => {
      const target = new URL(answer.target, request.origin);
      const response = await internal.fetch(new Request(target, c.req.raw), c.env);
      if (response.status === 404 && response.headers.get(unmatchedHeader) === '1') return { unmatched: true };
      return captureResponse(response, bench.maxResponseBytes);
    });
    return toResponse(rendered, c.req.method);
  });
  internal.notFound(() => new Response(null, { status: 404, headers: { [unmatchedHeader]: '1' } }));

  /** Validate a registration and return its upper-case method. */
  const register = (method: string, template: string, handlers: unknown[]) => {
    const verb = method.toLowerCase();
    if (!operationMethods.has(verb) || !handlers.length) {
      throw new TypeError('Choose a supported HTTP method and supply the route handler.');
    }
    const upper = verb.toUpperCase();
    if (operations.some(entry => entry.method === upper && entry.path === template)) {
      throw new TypeError('This operation is already registered.');
    }
    return upper;
  };

  app.unavailable = (method, template, options, ...handlers) => {
    const upper = register(method, template, handlers);
    const entry = unavailableOperation(upper, template, options);
    // Only the public router gets the handlers, so a Preview dispatch finds no operation.
    const [first, ...rest] = handlers as [OperationHandler<E>, ...OperationHandler<E>[]];
    app.on(upper, routePath(template), first, ...rest);
    operations.push({ ...entry, preview: false });
    return app;
  };

  app.operation = (method, template, ...handlers) => {
    const upper = register(method, template, handlers);
    const path = routePath(template);
    // The observation wrapper times and captures a real Send when the client asked for a trace.
    const observe: MiddlewareHandler<E> = async (c, next) => {
      if (c.req.method !== upper) return next();
      const observed = await bench.observation(describe(c, basePath));
      if (!observed) return next();
      await observed.run(next);
      const trace = observed.complete(c.res.status);
      if (trace) c.header('X-Sendproof-Trace', trace);
    };
    // The guard above guarantees at least one handler, as Hono's typings require.
    const [first, ...rest] = handlers as [OperationHandler<E>, ...OperationHandler<E>[]];
    app.on(upper, path, observe, first, ...rest);
    internal.on(upper, path, first, ...rest);
    operations.push({ method: upper, path: template });
    return app;
  };
  return app;
}
