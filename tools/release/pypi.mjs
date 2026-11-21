// PyPI: a wheel and an sdist for each of the five Python packages (hatchling backend).
//
// pack   copies each package into ctx.work, stamps the release version, the pinned sendproof-core
//        dependency and the project URLs into the copy, embeds the UI bundle into the core copy,
//        builds with `python -m build`, then inspects every archive (tools/release/consumers/pypi/check_dist.py).
// verify installs the wheels from ctx.out into a fresh virtual environment and serves the workbench
//        from a minimal FastAPI application (tools/release/consumers/pypi/app.py).
//
// Tracked files are never edited: version, pins and URLs exist only in the staging copies.

import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  exists, findPython, listFiles, output, removeDir, require, root, run, smokeServe, stage, tempDir, venvPython,
} from './lib.mjs';

export const title = 'PyPI';

/** Dist name -> directory under adapters/python. Order matters: core is built and installed first. */
const PACKAGES = [
  ['sendproof-core', 'core'],
  ['sendproof-sqlalchemy', 'sqlalchemy'],
  ['sendproof-fastapi', 'fastapi'],
  ['sendproof-flask', 'flask'],
  ['sendproof-django', 'django'],
];

const consumerFiles = join(root, 'tools', 'release', 'consumers', 'pypi');
const adapterVenv = join(root, 'adapters', 'python', '.venv');

/** Build tooling installed into a fresh environment when the repository's .venv is missing or lacks it. */
const BUILD_REQUIREMENTS = ['build==1.2.2.post1', 'hatchling==1.27.0', 'twine==6.1.0'];

export const registryVersion = versions => versions.pep440;

export async function available() {
  return findPython() ? null : 'Python 3.10 or newer was not found (tried python3, python and the py launcher)';
}

/** True when `python` can run `-c code` successfully. */
async function can(python, code) {
  try {
    await run(python, ['-c', code], { quiet: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Picks the interpreter that builds the packages: adapters/python/.venv when it already has build and
 * hatchling (the developer setup from scripts/prepare.py), otherwise a new environment in ctx.work.
 * SENDPROOF_PYPI_FRESH_ENV=1 forces the new environment, which is what CI uses.
 */
async function buildPython(ctx) {
  const existing = venvPython(adapterVenv);
  if (!process.env.SENDPROOF_PYPI_FRESH_ENV && await exists(existing) && await can(existing, 'import build, hatchling')) {
    ctx.log(`building with ${existing}`);
    return existing;
  }
  const [python, ...prefix] = findPython();
  const environment = join(ctx.work, 'build-env');
  ctx.log('creating a build environment with pinned build tools');
  await run(python, [...prefix, '-m', 'venv', environment], { label: 'pypi' });
  const interpreter = venvPython(environment);
  await run(interpreter, ['-m', 'pip', 'install', '--disable-pip-version-check', '--quiet', ...BUILD_REQUIREMENTS], { label: 'pypi' });
  return interpreter;
}

/** Replaces exactly one match of `pattern` in `text`, or throws naming the file. */
function replaceOnce(text, pattern, replacement, where) {
  const matches = text.match(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`)) ?? [];
  require(matches.length === 1, `${where}: expected one match for ${pattern}, found ${matches.length}`);
  return text.replace(pattern, replacement);
}

/** Copies one package into the work directory and stamps release metadata into the copy. */
async function stagePackage(ctx, name, folder, repositoryUrl) {
  const module = name.replace('-', '_');
  const destination = join(ctx.work, 'stage', folder);
  // The embedded UI is regenerated below, so a stale local copy must never leak into the archive.
  await stage(join(root, 'adapters', 'python', folder), destination, { exclude: ['tests', 'ui'] });

  const pyproject = join(destination, 'pyproject.toml');
  let text = await readFile(pyproject, 'utf8');
  require(!/\[project\.urls\]/.test(text), `${pyproject} must not hold project URLs; they are stamped from the repository`);
  text = replaceOnce(text, /^version = "[^"]+"$/m, `version = "${ctx.versions.pep440}"`, pyproject);
  if (name !== 'sendproof-core') {
    text = replaceOnce(text, /"sendproof-core==[^"]+"/, `"sendproof-core==${ctx.versions.pep440}"`, pyproject);
  }
  text = `${text.trimEnd()}\n\n[project.urls]\n` + [
    ['Homepage', `${repositoryUrl}/tree/main/adapters/python/${folder}`],
    ['Repository', repositoryUrl],
    ['Issues', `${repositoryUrl}/issues`],
    ['Changelog', `${repositoryUrl}/blob/main/CHANGELOG.md`],
  ].map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join('\n') + '\n';
  await writeFile(pyproject, text);

  // __version__ is a literal in the runtime source; the staged copy gets the release version too.
  const init = join(destination, 'src', module, '__init__.py');
  await writeFile(init, replaceOnce(await readFile(init, 'utf8'), /^__version__ = "[^"]+"$/m, `__version__ = "${ctx.versions.pep440}"`, init));

  if (name === 'sendproof-core') {
    await run(process.execPath, [join(root, 'tools', 'pack-ui.mjs'), '--version', ctx.version, '--out', join(destination, 'src', module, 'ui')], { label: 'pypi' });
  }
  return destination;
}

export async function pack(ctx) {
  const python = await buildPython(ctx);
  const env = {};
  if (ctx.commit) {
    // Reproducible archives: hatchling stamps file times from SOURCE_DATE_EPOCH.
    try { env.SOURCE_DATE_EPOCH = await output('git', ['log', '-1', '--format=%ct', ctx.commit], { cwd: root }); } catch { /* not a checkout */ }
  }
  for (const [name, folder] of PACKAGES) {
    ctx.log(`${name} ${ctx.versions.pep440}`);
    const source = await stagePackage(ctx, name, folder, ctx.repository.url);
    // `python -m build` builds the sdist first and then the wheel from that sdist, so a wheel that
    // builds proves the sdist is self-contained. --no-isolation uses the pinned build environment.
    await run(python, ['-m', 'build', '--no-isolation', '--outdir', ctx.out, source], { cwd: ctx.work, env, label: 'pypi', quiet: true });
  }

  await run(python, [join(consumerFiles, 'check_dist.py'), ctx.out, ctx.version, ctx.versions.pep440, ctx.repository.url], { label: 'pypi' });

  if (await can(python, 'import twine')) {
    const archives = (await listFiles(ctx.out)).map(file => join(ctx.out, file));
    await run(python, ['-m', 'twine', 'check', '--strict', ...archives], { label: 'pypi' });
  } else {
    ctx.log('twine is not installed in the build environment; skipping twine check --strict');
  }
  return listFiles(ctx.out);
}

export async function verify(ctx) {
  const [python, ...prefix] = findPython();
  const consumer = await tempDir('pypi');
  try {
    const environment = join(consumer, 'venv');
    await run(python, [...prefix, '-m', 'venv', environment], { label: 'pypi' });
    const interpreter = venvPython(environment);
    const wheels = (await listFiles(ctx.out)).filter(file => file.endsWith('.whl')).map(file => join(ctx.out, file));
    require(wheels.length === PACKAGES.length, `expected ${PACKAGES.length} wheels in ${ctx.out}, found ${wheels.length}`);

    // The wheels come from ctx.out; their third-party dependencies and uvicorn come from PyPI.
    await run(interpreter, ['-m', 'pip', 'install', '--disable-pip-version-check', '--quiet', ...wheels, 'uvicorn'], { cwd: consumer, label: 'pypi' });
    await run(interpreter, ['-m', 'pip', 'check'], { cwd: consumer, label: 'pypi' });

    // Every package imports from the installed wheel (never from the source tree) at the release version.
    const modules = PACKAGES.map(([name]) => name.replace('-', '_'));
    await run(interpreter, ['-c', [
      'import importlib, pathlib, sys',
      `expected = ${JSON.stringify(ctx.versions.pep440)}`,
      `for name in ${JSON.stringify(modules)}:`,
      '    module = importlib.import_module(name)',
      '    assert "site-packages" in pathlib.Path(module.__file__).parts, f"{name} imported from {module.__file__}"',
      '    assert module.__version__ == expected, f"{name} {module.__version__} != {expected}"',
      'print("imported", ", ".join(' + JSON.stringify(modules) + '))',
    ].join('\n')], { cwd: consumer, label: 'pypi' });

    await copyFile(join(consumerFiles, 'app.py'), join(consumer, 'app.py'));
    const { capabilities } = await smokeServe({ label: 'pypi', command: interpreter, args: ['app.py'], cwd: consumer });
    ctx.log(`served the workbench (OpenAPI ${capabilities.openApiUrl})`);
  } finally {
    if (!ctx.keep) await removeDir(consumer);
    else ctx.log(`kept consumer project at ${consumer}`);
  }
}
