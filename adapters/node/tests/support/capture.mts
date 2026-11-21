/** Test helper that runs a callback under a real Sendproof capture and returns what it recorded. */
import { Capture } from '@sendproof/core';
import type { CaptureLimits, CaptureSnapshot, SqlLog } from '@sendproof/core';

/** Run `callback` inside a capture and return its result with everything captured. */
export async function capturing<T>(
  callback: () => Promise<T>,
  { mode = 'preview', limits, parameterValues = false }:
    { mode?: 'preview' | 'send'; limits?: CaptureLimits; parameterValues?: boolean } = {},
): Promise<{ result: T; captured: CaptureSnapshot }> {
  const capture = new Capture(mode, limits, parameterValues);
  const result = await capture.run(callback);
  return { result, captured: capture.finish().capture };
}

/** The SQL entries among the captured logs, in execution order. */
export function sqlEntries(captured: CaptureSnapshot): SqlLog[] {
  return captured.logs.flatMap(log => (log.sql ? [log.sql] : []));
}
