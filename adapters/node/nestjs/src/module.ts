import { Inject, Module, RequestMethod } from '@nestjs/common';
import type { DynamicModule, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { APP_INTERCEPTOR, DiscoveryModule, HttpAdapterHost } from '@nestjs/core';
import { BenchInterceptor } from './interceptor.js';
import { optionsKey } from './options.js';
import type { NestBenchOptions } from './options.js';
import { BenchRuntime } from './runtime.js';
import type { ExpressApplication } from './runtime.js';

/** Nest module for the Express HTTP adapter. */
export class TestBenchModule implements NestModule {
  constructor(
    private readonly runtime: BenchRuntime,
    private readonly adapter: HttpAdapterHost,
  ) {}

  /** Import this in the root module: `imports: [TestBenchModule.forRoot({ … })]`. */
  static forRoot(options: NestBenchOptions = {}): DynamicModule {
    return {
      module: TestBenchModule,
      imports: [DiscoveryModule],
      providers: [
        { provide: optionsKey, useValue: options },
        BenchRuntime,
        { provide: APP_INTERCEPTOR, useClass: BenchInterceptor },
      ],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    const adapter = this.adapter.httpAdapter;
    if (adapter?.getType() !== 'express') throw new Error('Use the NestJS Express HTTP adapter with Test Bench.');
    consumer.apply(this.runtime.middleware(adapter.getInstance() as ExpressApplication))
      .forRoutes({ path: '{*path}', method: RequestMethod.ALL });
  }
}
Inject(BenchRuntime)(TestBenchModule, undefined, 0);
Inject(HttpAdapterHost)(TestBenchModule, undefined, 1);
Module({})(TestBenchModule);
