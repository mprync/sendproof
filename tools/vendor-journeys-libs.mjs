// Builds the browser copies of the Arazzo libraries ui/journeys/ relies on. The workbench ships
// with no bundler, so each dependency is bundled once here into a single self-contained ES
// module under ui/vendor/, with its licence kept as a header comment.
//
//   node tools/vendor-journeys-libs.mjs
//
// Re-run after bumping a version in tools/package.json. @redocly/respect-core, the Node-side
// Arazzo runtime, is not vendored: it depends on @redocly/openapi-core, which reaches for
// node:fs and node:path and can't bundle for the browser (see docs/plans/journeys-build.md,
// Contract 3). The CLI and MCP server (part E) copy this directory's output into their own
// package instead (tools/pack-journeys-engine.mjs), so every runner uses the one engine.
import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const tools = dirname(fileURLToPath(import.meta.url));
const vendorDir = join(tools, '../ui/vendor');

const packages = [
  { name: '@swaggerexpert/arazzo-runtime-expression', out: 'arazzo-runtime-expression.js', entry: "export * from '@swaggerexpert/arazzo-runtime-expression';" },
  { name: '@swaggerexpert/json-pointer', out: 'json-pointer.js', entry: "export * from '@swaggerexpert/json-pointer';" },
  { name: 'jsonpath-rfc9535', out: 'jsonpath-rfc9535.js', entry: "export * from 'jsonpath-rfc9535';" },
];

async function licenceHeader(name) {
  const pkg = JSON.parse(await readFile(join(tools, 'node_modules', name, 'package.json'), 'utf8'));
  const homepage = pkg.homepage ?? (typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url) ?? '';
  return `/*!\n * ${name} v${pkg.version} (${pkg.license})\n * ${homepage}\n * Vendored for the browser by tools/vendor-journeys-libs.mjs; bundled and minified, unmodified otherwise.\n */\n`;
}

for (const { name, out, entry } of packages) {
  const result = await build({
    stdin: { contents: entry, resolveDir: tools, sourcefile: `${out}.entry.js` },
    bundle: true, minify: true, format: 'esm', platform: 'browser', write: false,
  });
  const header = await licenceHeader(name);
  await writeFile(join(vendorDir, out), header + result.outputFiles[0].text);
  console.log(`${out}: ${result.outputFiles[0].text.length} bytes minified`);
}
