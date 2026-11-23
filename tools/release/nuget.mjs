// NuGet: Sendproof.AspNetCore, Sendproof.EntityFrameworkCore, the data-store guards (Sendproof.Redis, .MongoDB,
// .DynamoDB and the rest), and Sendproof.Journeys with Sendproof.Journeys.Testing, each with a symbol package.
//
// pack    `dotnet pack` with the release version and repository URL as MSBuild properties (the same
//         properties CI always used), into ctx.out.
// verify  tools/check-packages.py: inspects every package and its symbols, then restores the Acme Store
//         example from the archives only (private package cache, source mapping) and runs its tests,
//         which start the application and exercise the workbench and its OpenAPI document. A second
//         application registers all three data-store guards from the archives.

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { findPython, require, root, run, which } from './lib.mjs';

export const title = 'NuGet';

// Dependency order: the host first; every other package depends on it.
const PROJECTS = ['Sendproof.AspNetCore', 'Sendproof.EntityFrameworkCore', 'Sendproof.Redis', 'Sendproof.MongoDB', 'Sendproof.DynamoDB',
  'Sendproof.Cassandra', 'Sendproof.Elasticsearch', 'Sendproof.OpenSearch', 'Sendproof.CosmosDb', 'Sendproof.Firestore',
  // Journeys carry their operations generator inside as an analyzer; the testing package depends on them.
  'Sendproof.Journeys', 'Sendproof.Journeys.Testing'];

export async function available() {
  if (!which('dotnet')) return 'the .NET SDK (dotnet) is not on PATH';
  if (!findPython()) return 'Python 3.10+ is needed for tools/check-packages.py';
  return null;
}

const properties = ctx => [
  `-p:Version=${ctx.version}`,
  `-p:RepositoryUrl=${ctx.repository.url}`,
  ...(process.env.CI ? ['-p:ContinuousIntegrationBuild=true'] : []),
];

export async function pack(ctx) {
  for (const project of PROJECTS) {
    await run('dotnet', ['pack', join(root, 'adapters', 'dotnet', project), '-c', 'Release', '-o', ctx.out, '-warnaserror', ...properties(ctx)],
      { cwd: root, label: 'nuget' });
  }
  const files = (await readdir(ctx.out)).filter(name => /\.s?nupkg$/.test(name)).sort();
  require(files.length === PROJECTS.length * 2, `expected ${PROJECTS.length} packages and ${PROJECTS.length} symbol packages, found ${files.join(', ')}`);
  return files;
}

export async function verify(ctx) {
  const [python, ...prefix] = findPython();
  await run(python, [...prefix, join(root, 'tools', 'check-packages.py'), ctx.out], {
    cwd: root, label: 'nuget', env: { REPOSITORY_URL: ctx.repository.url },
  });
}
