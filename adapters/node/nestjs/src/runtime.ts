import { Inject } from '@nestjs/common';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { createBench } from '@sendproof/core';
import type { BenchRequest } from '@sendproof/core';
import { captureResponse, readSessionBody, sendResponse } from '@sendproof/core/node-http';
import { previewOperation } from './decorator.js';
import type { PreviewOperation } from './decorator.js';
import { optionsKey } from './options.js';
import type { NestBenchOptions } from './options.js';

/** The Express application Nest wraps, as far as the runtime needs it. */
export interface ExpressApplication {
  handle(req: Request, res: Response, done: (error?: unknown) => void): void;
}

/** Per-request state for an in-process Preview dispatch. */
export interface InternalState {
  /** Set once the interceptor confirms the request reached an eligible controller action. */
  entered: boolean;
  sessionRead: boolean;
}

const basePathPattern = /^\/[a-zA-Z0-9._~-]+(?:\/[a-zA-Z0-9._~-]+)*$/;

/** Shared state behind the module: protocol core, discovered operations and the preview middleware. */
export class BenchRuntime implements OnApplicationBootstrap, OnModuleDestroy {
  /** Requests currently being re-dispatched for Preview. */
  readonly internal = new WeakMap<Request, InternalState>();
  readonly basePath: string;
  readonly bench: ReturnType<typeof createBench<Request>>;
  private operations: PreviewOperation[] = [];

  constructor(
    options: NestBenchOptions,
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
  ) {
    this.basePath = options.basePath ?? '';
    if (this.basePath && (!basePathPattern.test(this.basePath) || this.basePath.split('/').some(part => part === '.' || part === '..'))) {
      throw new TypeError('Use a literal NestJS prefix for basePath.');
    }
    const { basePath: _basePath, ...benchOptions } = options;
    this.bench = createBench<Request>({ openApiUrl: '/api-json', ...benchOptions }, () => this.operations.map(
      ({ method, path, enabled, reason, stores }) => enabled === false
        ? { method, path, preview: false as const, reason: reason!, ...(stores ? { stores } : {}) }
        : { method, path }), { language: 'node', framework: 'NestJS' });
  }

  onModuleDestroy() {
    return this.bench.close();
  }

  /** Collect every controller action decorated with `@SendproofPreview`. */
  onApplicationBootstrap(): void {
    const operations = new Map<string, PreviewOperation>();
    for (const { instance } of this.discovery.getControllers()) {
      if (!instance) continue;
      for (const name of this.scanner.getAllMethodNames(Object.getPrototypeOf(instance))) {
        const operation = previewOperation((instance as Record<string, unknown>)[name]);
        if (operation) operations.set(operation.method + ' ' + operation.path, operation);
      }
    }
    this.operations = [...operations.values()];
  }

  /** Describe an Express request for the core; `null` when it lies outside the configured prefix. */
  context(req: Request): BenchRequest<Request> | null {
    const queryAt = req.originalUrl.indexOf('?');
    const absolutePath = queryAt < 0 ? req.originalUrl : req.originalUrl.slice(0, queryAt);
    if (this.basePath && !absolutePath.startsWith(this.basePath + '/')) return null;
    return {
      method: req.method,
      pathname: absolutePath.slice(this.basePath.length),
      query: queryAt < 0 ? '' : req.originalUrl.slice(queryAt),
      basePath: this.basePath,
      origin: `${req.protocol}://${req.get('host') ?? ''}`,
      headers: req.headers,
      raw: req,
    };
  }

  /** Express middleware that serves the workbench and re-enters the application for Preview. */
  middleware(application: ExpressApplication): RequestHandler {
    return async (req: Request, res: Response, next: NextFunction) => {
      if (this.internal.has(req)) return next();
      const context = this.context(req);
      if (!context) return next();
      const answer = await this.bench.lookup(context, () => readSessionBody(req));
      if (!answer) return next();
      if (!('target' in answer)) return sendResponse(req, res, answer);

      const result = await this.bench.preview(context, async () => {
        const target = this.basePath + answer.target;
        const state: InternalState = { entered: false, sessionRead: req.method === 'GET' && Boolean(answer.session) };
        this.internal.set(req, state);
        try {
          const response = await captureResponse(
            (request, response, done) => application.handle(request, response, done), req, res,
            target, this.bench.maxResponseBytes, target,
          );
          if ('unmatched' in response) return response;
          if (!state.entered) {
            // A guard or filter answered before the controller action was reached.
            if ([401, 403].includes(response.status)) return response;
            if (response.status >= 300 && response.status < 400) return { ...response, status: 401 };
            return { unmatched: true as const };
          }
          return response;
        } finally {
          this.internal.delete(req);
        }
      }, answer.session);
      return sendResponse(req, res, result);
    };
  }
}
Inject(optionsKey)(BenchRuntime, undefined, 0);
Inject(DiscoveryService)(BenchRuntime, undefined, 1);
Inject(MetadataScanner)(BenchRuntime, undefined, 2);
