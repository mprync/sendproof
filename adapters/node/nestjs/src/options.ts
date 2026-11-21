import type { Request } from 'express';
import type { BenchOptions } from '@test-bench/core';

/** Options for {@link TestBenchModule.forRoot}. */
export interface NestBenchOptions extends BenchOptions<Request> {
  /** The path base used by Nest's setGlobalPrefix. */
  basePath?: string;
}

/** Injection token carrying the module options. */
export const optionsKey = Symbol('Test Bench options');
