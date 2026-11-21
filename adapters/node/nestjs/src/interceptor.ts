import { HttpException, Inject } from '@nestjs/common';
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import { observeResponse } from '@sendproof/core/node-http';
import { Observable, from, mergeMap } from 'rxjs';
import { previewOperation } from './decorator.js';
import { BenchRuntime } from './runtime.js';

/**
 * Global interceptor that marks Preview dispatches as having reached a
 * controller action, and records a trace for observed Send requests.
 */
export class BenchInterceptor implements NestInterceptor {
  constructor(private readonly runtime: BenchRuntime) {}

  intercept(execution: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (execution.getType() !== 'http') return next.handle();
    const http = execution.switchToHttp();
    const req = http.getRequest<Request>();
    const operation = previewOperation(execution.getHandler());
    const internal = this.runtime.internal.get(req);
    // An action marked `enabled: false` is never eligible: Preview refuses it and Send isn't traced.
    const eligible = operation?.method === req.method && operation.enabled !== false;
    if (internal) {
      if (!eligible) throw new HttpException('This operation is unavailable for preview.', 409);
      internal.entered = true;
      return next.handle();
    }
    const context = eligible ? this.runtime.context(req) : null;
    if (!context) return next.handle();
    return from(this.runtime.bench.observation(context)).pipe(mergeMap(observation => {
      if (!observation) return next.handle();
      observeResponse(http.getResponse<Response>(), observation);
      return new Observable<unknown>(subscriber => observation.run(() => next.handle().subscribe(subscriber)));
    }));
  }
}
Inject(BenchRuntime)(BenchInterceptor, undefined, 0);
