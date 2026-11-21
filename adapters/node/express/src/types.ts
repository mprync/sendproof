import type { Request, RequestHandler } from 'express';
import type { BenchOptions } from '@test-bench/core';

/** Options accepted by {@link testBench}; request callbacks receive the Express request as `raw`. */
export type ExpressBenchOptions = BenchOptions<Request>;

/** Express middleware that also registers rollback-eligible operations. */
export interface TestBenchMiddleware extends RequestHandler {
  /**
   * Register a rollback-eligible operation on the workbench mount's Express router.
   *
   * @param method One of GET, POST, PUT, PATCH, DELETE or OPTIONS (case-insensitive).
   * @param template An OpenAPI path template such as `/items/{id}`.
   * @param handlers The real route handler chain, run for both Send and Preview.
   */
  operation(method: string, template: string, ...handlers: RequestHandler[]): TestBenchMiddleware;
}
