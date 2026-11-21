import type { Request, RequestHandler } from 'express';
import type { BenchOptions, UnavailableOptions } from '@sendproof/core';

/** Options accepted by {@link sendproof}; request callbacks receive the Express request as `raw`. */
export type ExpressBenchOptions = BenchOptions<Request>;

/** Express middleware that also registers rollback-eligible operations. */
export interface SendproofMiddleware extends RequestHandler {
  /**
   * Register a rollback-eligible operation on the workbench mount's Express router.
   *
   * @param method One of GET, POST, PUT, PATCH, DELETE or OPTIONS (case-insensitive).
   * @param template An OpenAPI path template such as `/items/{id}`.
   * @param handlers The real route handler chain, run for both Send and Preview.
   */
  operation(method: string, template: string, ...handlers: RequestHandler[]): SendproofMiddleware;
  /**
   * Register an operation marked `preview: false`, for one that writes to a guarded store such as
   * Redis. Send runs the handlers as usual; capabilities list it in `previewUnavailable` with the
   * reason, and a Preview of it answers 409 without running them.
   *
   * @param options The reason the UI shows, the stores it writes, or both.
   */
  unavailable(method: string, template: string, options: UnavailableOptions, ...handlers: RequestHandler[]): SendproofMiddleware;
}
