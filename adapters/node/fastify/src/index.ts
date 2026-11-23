import type { IncomingMessage } from 'node:http';
import type { FastifyInstance, FastifyRequest, RouteOptions } from 'fastify';
import plugin from 'fastify-plugin';
import { createBench, unavailableOperation } from '@sendproof/core';
import { readSessionBody } from '@sendproof/core/node-http';
import type { RegisteredOperation, UnavailableOptions } from '@sendproof/core';
import { requestContext, sendTransport } from './context.js';
import { dispatching, dispatchInProcess, matchedResponses } from './dispatch.js';
import { operationMethod, routePath, OPERATION_METHODS } from './paths.js';
import type { FastifyBenchOptions, OperationRoute, Sendproof } from './types.js';

export type { FastifyBenchOptions, OperationRoute, Sendproof } from './types.js';

/** Route config key marking a route as a registered, preview-eligible operation. */
const eligible = Symbol('sendproofEligible');

type Bench = ReturnType<typeof createBench<FastifyRequest>>;
type Observation = NonNullable<Awaited<ReturnType<Bench['observation']>>>;

declare module 'fastify' {
  interface FastifyInstance {
    /** Register preview- and trace-eligible operations; added by the `@sendproof/fastify` plugin. */
    sendproof: Sendproof;
  }
}

/** Whether Fastify matched a route that was registered through `app.sendproof.operation`. */
function routeEligibility(request: FastifyRequest): boolean | undefined {
  const config = request.routeOptions.config as unknown as Record<symbol, unknown> | undefined;
  const value = config?.[eligible];
  return typeof value === 'boolean' ? value : undefined;
}

/** Register Sendproof on a Fastify instance before registering its other routes. */
function registerSendproof(app: FastifyInstance, options: FastifyBenchOptions): Sendproof {
  const basePath = app.prefix === '/' ? '' : app.prefix;
  const operations: RegisteredOperation[] = [];
  const observations = new WeakMap<IncomingMessage, Observation>();
  const bench = createBench<FastifyRequest>(options, () => operations, { language: 'node', framework: 'Fastify' });
  app.addHook('preClose', bench.close);

  app.addHook('onRequest', (request, reply, done) => {
    const internal = dispatching.get(request.raw);
    const route = routeEligibility(request);
    if (internal) {
      if (route === false || (!route && (!internal.sessionRead || request.is404))) return reply.code(404).send();
      matchedResponses.add(reply.raw);
      return done();
    }
    const context = requestContext(request, basePath);
    bench.lookup(context, () => readSessionBody(request.raw)).then(async answer => {
      if (answer) {
        reply.hijack();
        const response = 'target' in answer
          ? await bench.preview(context, () => dispatchInProcess(
            app, request.raw, basePath + answer.target, bench.maxResponseBytes, request.method === 'GET' && Boolean(answer.session),
          ), answer.session)
          : answer;
        sendTransport(reply, response, request.method);
        return;
      }
      if (!route) return done();
      const observed = await bench.observation(context);
      if (!observed) return done();
      observations.set(request.raw, observed);
      observed.run(done);
    }).catch(done);
  });

  app.addHook('onSend', (request, reply, payload, done) => {
    const observed = observations.get(request.raw);
    if (observed) {
      const trace = observed.complete(reply.statusCode);
      if (trace) reply.header('X-Sendproof-Trace', trace);
    }
    done(null, payload);
  });

  // These routes let Fastify route the workbench through the same hooks as application routes.
  for (const url of ['/sendproof', '/sendproof/*']) {
    app.route({ method: [...OPERATION_METHODS, 'HEAD'], url, handler: (_request, reply) => reply.code(404).send() });
  }

  /** Validate a registration and return its method and route definition. */
  const register = (method: string, template: string, route: OperationRoute) => {
    const verb = operationMethod(method);
    const definition = typeof route === 'function' ? { handler: route } : route;
    if (!verb || typeof definition?.handler !== 'function') {
      throw new TypeError('Choose a supported HTTP method and supply the route handler.');
    }
    if (operations.some(entry => entry.method === verb && entry.path === template)) {
      throw new TypeError('This operation is already registered.');
    }
    return { verb, definition };
  };

  const api: Sendproof = {
    unavailable(method: string, template: string, options: UnavailableOptions, route: OperationRoute) {
      const { verb, definition } = register(method, template, route);
      const entry = unavailableOperation(verb, template, options);
      app.route({
        ...definition, method: verb, url: routePath(template),
        config: { ...definition.config, [eligible]: false },
      } as RouteOptions);
      operations.push({ ...entry, preview: false });
      return api;
    },
    operation(method: string, template: string, route: OperationRoute) {
      const { verb, definition } = register(method, template, route);
      app.route({
        ...definition, method: verb, url: routePath(template),
        config: { ...definition.config, [eligible]: true },
      } as RouteOptions);
      operations.push({ method: verb, path: template });
      return api;
    },
  };
  return api;
}

/** Fastify 5 plugin. Register before the routes that use `app.sendproof`. */
export const sendproof = plugin<FastifyBenchOptions>(async (app, options) => {
  app.decorate('sendproof', registerSendproof(app, options));
}, { name: 'sendproof', fastify: '5.x' });
