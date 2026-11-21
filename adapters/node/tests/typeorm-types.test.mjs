import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const loadTypeScript = () => { try { return require('typescript'); } catch { return undefined; } };
const ts = loadTypeScript();

test('generated declarations type check for a strict consumer and reject misuse', { skip: ts ? false : 'typescript is not installed' }, () => {
  const file = fileURLToPath(new URL('./typeorm-types/consumer.mts', import.meta.url));
  const program = ts.createProgram([file], {
    strict: true, noEmit: true, skipLibCheck: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true,
    module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, target: ts.ScriptTarget.ES2022, types: ['node'],
  });
  const diagnostics = ts.getPreEmitDiagnostics(program).map(diagnostic =>
    ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n') + ` (${diagnostic.file?.fileName}:${diagnostic.start})`);
  assert.deepEqual(diagnostics, []);
});
