import type { Request } from 'express';
import type { BenchOptions } from '@sendproof/core';

/** Options for {@link SendproofModule.forRoot}. */
export interface NestBenchOptions extends BenchOptions<Request> {
  /** The path base used by Nest's setGlobalPrefix. */
  basePath?: string;
}

/** Injection token carrying the module options. */
export const optionsKey = Symbol('Sendproof options');
