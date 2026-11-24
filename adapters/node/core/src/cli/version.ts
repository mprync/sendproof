// The package version, read from @sendproof/core's package.json (two levels up from src/cli and dist/cli).
import { createRequire } from 'node:module';

export const VERSION: string = createRequire(import.meta.url)('../../package.json').version;
