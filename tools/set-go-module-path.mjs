#!/usr/bin/env node
/**
 * Sets the Go module path of the Test Bench Go modules once the repository
 * location is known.
 *
 *   node tools/set-go-module-path.mjs <repository path>        rewrite
 *   node tools/set-go-module-path.mjs <repository path> --dry-run
 *   node tools/set-go-module-path.mjs --check                  verify only
 *
 * The repository path is the import path of the repository root, for example
 * `github.com/acme/test-bench`. The Go modules live under `adapters/go`, so the
 * module base becomes `<repository path>/adapters/go`.
 *
 * `adapters/go/MODULE_PATH` is the single authoritative record of the current
 * base. The tool replaces that base, at whole-path boundaries only, in these
 * files under `adapters/go` and nowhere else:
 *
 *   go.mod, go.work   module, require and replace lines
 *   *.go              import paths and documentation
 *   *.md              documentation
 *   MODULE_PATH       the record itself
 *
 * It never touches go.sum, go.work.sum, the embedded UI (`internal/ui/dist`),
 * dependency caches or any file outside `adapters/go`. Before anything is
 * written it proves that
 *
 *   - the new path is a well-formed Go module path,
 *   - every changed file only differs by the base (reversing the rewrite
 *     reproduces the original bytes),
 *   - no file the tool does not manage still names the old base, and
 *   - no go.mod carries a replace directive.
 *
 * Any failed proof leaves the tree untouched. Writes go through temporary files
 * and are rolled back if one fails.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Directory names never entered. `dist` is only skipped inside `internal/ui`. */
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', 'artifacts', 'vendor']);
/** Files that may name the base and are rewritten. */
const MANAGED = (name) => name === 'go.mod' || name === 'go.work' || name === 'MODULE_PATH' || name.endsWith('.go') || name.endsWith('.md');
/** Files that must never name the base (checksums of third-party modules only). */
const NEVER_REWRITTEN = new Set(['go.sum', 'go.work.sum']);
/** Characters that may continue a module path element. */
const PATH_CHARACTER = '[A-Za-z0-9._~-]';

/** Error whose message is shown without a stack trace. */
export class UsageError extends Error {}

/**
 * Validates a repository path and returns the module base.
 * Follows the module path rules of golang.org/x/mod/module for the URL-like
 * paths a repository can have.
 */
export function moduleBaseFor(repository) {
  if (typeof repository !== 'string' || repository.length === 0) throw new UsageError('A repository path such as github.com/acme/test-bench is required.');
  if (/\s/.test(repository)) throw new UsageError(`Repository path must not contain whitespace: ${JSON.stringify(repository)}`);
  if (repository.includes('://') || repository.includes('@') || repository.includes('?') || repository.includes('#')) {
    throw new UsageError(`Give the import path without scheme, credentials or query, for example github.com/acme/test-bench: ${repository}`);
  }
  if (repository.startsWith('/') || repository.endsWith('/') || repository.includes('//')) {
    throw new UsageError(`Repository path must not start or end with "/" or contain "//": ${repository}`);
  }
  if (repository.endsWith('.git')) throw new UsageError(`Leave off the ".git" suffix: ${repository}`);
  const elements = repository.split('/');
  if (elements.length < 2) throw new UsageError(`Repository path needs a host and a repository, for example github.com/acme/test-bench: ${repository}`);
  if (!elements[0].includes('.')) throw new UsageError(`The first path element must be a domain name containing a dot: ${repository}`);
  for (const element of elements) {
    if (!new RegExp(`^${PATH_CHARACTER}+$`).test(element)) throw new UsageError(`Invalid character in path element ${JSON.stringify(element)}`);
    if (element.startsWith('.') || element.endsWith('.') || element.includes('..')) throw new UsageError(`Path element ${JSON.stringify(element)} must not start or end with "." or contain ".."`);
  }
  if (/^v\d+$/.test(elements[elements.length - 1])) throw new UsageError('A trailing /vN element would make the modules a major-version path; give the repository path only.');
  return `${repository}/adapters/go`;
}

/** Matches `base` only as a whole module path prefix (not inside a longer element or host). */
function baseExpression(base) {
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Not preceded by a path character or "/" (a URL or a longer path), and not
  // continued by a path character (a dot ends a sentence unless more path follows).
  return new RegExp(`(?<![A-Za-z0-9._~/-])${escaped}(?![A-Za-z0-9_~-]|\\.[A-Za-z0-9_~-])`, 'g');
}

/** Replaces the base everywhere in `text`, returning the new text and the number of replacements. */
export function replaceBase(text, from, to) {
  let count = 0;
  const result = text.replace(baseExpression(from), () => { count++; return to; });
  return { result, count };
}

/** Lists files under `dir` (relative to `adapters/go`), skipping directories that are never managed. */
function walk(goRoot, dir = '') {
  const files = [];
  for (const entry of fs.readdirSync(path.join(goRoot, dir), { withFileTypes: true })) {
    const relative = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name) || relative === 'internal/ui/dist') continue;
      files.push(...walk(goRoot, relative));
    } else if (entry.isFile()) {
      files.push(relative);
    }
  }
  return files.sort();
}

/** True for text we can safely scan for the base (rejects binary content). */
function isText(buffer) {
  return !buffer.includes(0);
}

/** Reads the authoritative base from MODULE_PATH. */
export function readBase(goRoot) {
  const file = path.join(goRoot, 'MODULE_PATH');
  if (!fs.existsSync(file)) throw new UsageError(`${file} is missing; it records the module base.`);
  const base = fs.readFileSync(file, 'utf8').trim();
  if (!base.endsWith('/adapters/go')) throw new UsageError(`MODULE_PATH must end with /adapters/go: ${base}`);
  moduleBaseFor(base.slice(0, -'/adapters/go'.length));
  return base;
}

/**
 * Collects problems that make the tree inconsistent with `base`: go.mod files
 * with replace directives or a module line outside the base, and go.work
 * replace lines that are not internal.
 */
export function checkTree(goRoot, base) {
  const problems = [];
  const prefix = (value) => value === base || value.startsWith(`${base}/`);
  for (const relative of walk(goRoot)) {
    const name = path.basename(relative);
    if (name !== 'go.mod' && name !== 'go.work') continue;
    const text = fs.readFileSync(path.join(goRoot, relative), 'utf8');
    if (name === 'go.mod') {
      const module = /^module\s+(\S+)/m.exec(text);
      if (!module) problems.push(`${relative}: no module line`);
      else if (!prefix(module[1])) problems.push(`${relative}: module ${module[1]} is outside ${base}`);
      if (/^\s*replace\b/m.test(text)) problems.push(`${relative}: go.mod must not contain a replace directive (use go.work for local development)`);
    } else {
      for (const match of text.matchAll(/^\s*(?:replace\s+)?(\S+)\s+(v\S+)\s+=>\s+\S+/gm)) {
        if (!prefix(match[1])) problems.push(`${relative}: replace of ${match[1]} is not an internal module`);
      }
    }
  }
  return problems;
}

/**
 * Computes the rewrite without touching the disk.
 * @returns {{ base: string, changes: Array<{file: string, replacements: number, before: string, after: string}> }}
 */
export function plan(goRoot, newBase) {
  const base = readBase(goRoot);
  const problems = [];
  const changes = [];
  const files = walk(goRoot);
  for (const relative of files) {
    const name = path.basename(relative);
    const buffer = fs.readFileSync(path.join(goRoot, relative));
    if (!isText(buffer)) continue;
    const before = buffer.toString('utf8');
    const occurrences = replaceBase(before, base, newBase);
    if (occurrences.count === 0) continue;
    if (NEVER_REWRITTEN.has(name) || !MANAGED(name)) {
      problems.push(`${relative}: names ${base} but is not a file this tool manages; update it by hand or extend the tool`);
      continue;
    }
    const after = name === 'MODULE_PATH' ? `${newBase}\n` : occurrences.result;
    if (name !== 'MODULE_PATH') {
      // Reversing the rewrite must reproduce the original: nothing else changed.
      const reversed = replaceBase(after, newBase, base).result;
      if (reversed !== before) problems.push(`${relative}: rewriting is not reversible (the new path overlaps text already in the file)`);
    }
    changes.push({ file: relative, replacements: occurrences.count, before, after });
  }
  problems.push(...checkTree(goRoot, base));
  return { base, changes, problems };
}

/** Writes `changes` through temporary files, restoring the originals if a write fails. */
function apply(goRoot, changes) {
  const written = [];
  try {
    for (const change of changes) {
      const target = path.join(goRoot, change.file);
      const temporary = `${target}.set-go-module-path.tmp`;
      const mode = fs.statSync(target).mode;
      fs.writeFileSync(temporary, change.after, { mode });
      fs.renameSync(temporary, target);
      written.push(change);
    }
  } catch (error) {
    for (const change of written) fs.writeFileSync(path.join(goRoot, change.file), change.before);
    throw error;
  }
}

/** Command line entry point. Returns the process exit code. */
export function main(argv, { root, out = process.stdout, err = process.stderr } = {}) {
  // `--root <dir>` points at another checkout (the release verification copies the tree).
  const rootIndex = argv.indexOf('--root');
  if (rootIndex !== -1) {
    root = argv[rootIndex + 1] ? path.resolve(argv[rootIndex + 1]) : root;
    argv = argv.filter((_, index) => index !== rootIndex && index !== rootIndex + 1);
  }
  const repositoryRoot = root ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const goRoot = path.join(repositoryRoot, 'adapters', 'go');
  const flags = new Set(argv.filter((argument) => argument.startsWith('--')));
  const positional = argv.filter((argument) => !argument.startsWith('--'));
  try {
    const unknown = [...flags].filter((flag) => !['--dry-run', '--check', '--help'].includes(flag));
    if (unknown.length > 0) throw new UsageError(`Unknown option ${unknown[0]}`);
    if (flags.has('--help')) {
      out.write('usage: set-go-module-path.mjs <repository path> [--dry-run] [--root <checkout>] | --check [--root <checkout>]\n');
      return 0;
    }
    if (flags.has('--check')) {
      const base = readBase(goRoot);
      const problems = checkTree(goRoot, base);
      for (const problem of problems) err.write(`${problem}\n`);
      if (problems.length === 0) out.write(`Go module metadata is consistent with ${base}.\n`);
      return problems.length === 0 ? 0 : 1;
    }
    if (positional.length !== 1) throw new UsageError('Give exactly one repository path, for example: node tools/set-go-module-path.mjs github.com/acme/test-bench');
    const newBase = moduleBaseFor(positional[0]);
    const { base, changes, problems } = plan(goRoot, newBase);
    if (problems.length > 0) {
      err.write(`Not changing anything:\n${problems.map((problem) => `  ${problem}`).join('\n')}\n`);
      return 1;
    }
    if (base === newBase) {
      out.write(`Module base is already ${newBase}.\n`);
      return 0;
    }
    for (const change of changes) out.write(`${flags.has('--dry-run') ? 'would update' : 'updated'} adapters/go/${change.file} (${change.replacements})\n`);
    if (!flags.has('--dry-run')) apply(goRoot, changes);
    out.write(`${flags.has('--dry-run') ? 'Dry run: ' : ''}${base} -> ${newBase} in ${changes.length} files.\n`);
    if (!flags.has('--dry-run')) out.write('Next: run adapters/go/scripts/tidy.sh, then adapters/go/scripts/test.sh.\n');
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      err.write(`${error.message}\n`);
      return 2;
    }
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
