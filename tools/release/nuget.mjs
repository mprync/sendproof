// NuGet: TestBench.AspNetCore and TestBench.EntityFrameworkCore, with symbol packages.
//
// pack    `dotnet pack` with the release version and repository URL as MSBuild properties (the same
//         properties CI always used), into ctx.out.
// verify  tools/check-packages.py: inspects both packages and their symbols, then restores the Treasury
//         example from the archives only (private package cache, source mapping) and runs its tests,
//         which start the application and exercise the workbench and its OpenAPI document.

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { findPython, require, root, run, which } from './lib.mjs';

export const title = 'NuGet';

const PROJECTS = ['TestBench.AspNetCore', 'TestBench.EntityFrameworkCore'];

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
  require(files.length === 4, `expected two packages and two symbol packages, found ${files.join(', ')}`);
  return files;
}

export async function verify(ctx) {
  const [python, ...prefix] = findPython();
  await run(python, [...prefix, join(root, 'tools', 'check-packages.py'), ctx.out], {
    cwd: root, label: 'nuget', env: { REPOSITORY_URL: ctx.repository.url },
  });
}
