import type { FastifyReply, FastifyRequest, RouteOptions } from 'fastify';
import type { BenchOptions } from '@test-bench/core';

/** Options accepted by the `testBench` plugin; request callbacks receive the Fastify request as `raw`. */
export type FastifyBenchOptions = BenchOptions<FastifyRequest>;

/** A bare handler, or a route definition with hooks, schema and other Fastify route options. */
export type OperationRoute =
  | Omit<RouteOptions, 'method' | 'url'>
  | ((request: FastifyRequest, reply: FastifyReply) => unknown);

/** The `app.testBench` decoration. */
export interface TestBench {
  /** Register an operation whose handler participates in preview and observed Send. */
  operation(method: string, template: string, route: OperationRoute): TestBench;
}
