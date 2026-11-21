import type { FastifyReply, FastifyRequest, RouteOptions } from 'fastify';
import type { BenchOptions, UnavailableOptions } from '@sendproof/core';

/** Options accepted by the `sendproof` plugin; request callbacks receive the Fastify request as `raw`. */
export type FastifyBenchOptions = BenchOptions<FastifyRequest>;

/** A bare handler, or a route definition with hooks, schema and other Fastify route options. */
export type OperationRoute =
  | Omit<RouteOptions, 'method' | 'url'>
  | ((request: FastifyRequest, reply: FastifyReply) => unknown);

/** The `app.sendproof` decoration. */
export interface Sendproof {
  /** Register an operation whose handler participates in preview and observed Send. */
  operation(method: string, template: string, route: OperationRoute): Sendproof;
  /**
   * Register an operation marked `preview: false`, for one that writes to a guarded store such as
   * Redis. Send runs it as usual; capabilities list it in `previewUnavailable` with the reason, and
   * a Preview of it is refused without running the handler.
   */
  unavailable(method: string, template: string, options: UnavailableOptions, route: OperationRoute): Sendproof;
}
