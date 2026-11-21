import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { main, moduleBaseFor, replaceBase } from '../../tools/set-go-module-path.mjs';

const OLD = 'example.com/old/repo/adapters/go';
const NEW = 'github.com/acme/test-bench/adapters/go';
const realRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Writes `files` (relative path -> text or Buffer) under a fresh temporary repository root. */
function repository(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'go-module-path-'));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, 'adapters', 'go', relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return root;
}

/** Standard small tree: a core module, a framework module, an example and files that must not change. */
function sampleFiles() {
  return {
    MODULE_PATH: `${OLD}\n`,
    'go.mod': `module ${OLD}\n\ngo 1.24\n`,
    'go.work': `go 1.26.0\n\nuse (\n\t.\n\t./chi\n)\n\nreplace (\n\t${OLD} v0.1.0 => ./\n\t${OLD}/chi v0.1.0 => ./chi\n)\n`,
    'go.work.sum': 'golang.org/x/text v0.20.0 h1:abc=\n',
    'chi/go.mod': `module ${OLD}/chi\n\ngo 1.24\n\nrequire ${OLD} v0.1.0\n`,
    'chi/go.sum': 'github.com/go-chi/chi/v5 v5.5.0 h1:abc=\n',
    'chi/chi.go': `// Package chibench marks routes. See ${OLD}/testbench.\npackage chibench\n\nimport "${OLD}/testbench"\n\nvar _ = testbench.New\n`,
    'testbench/bench.go': `package testbench\n\n// Module ${OLD} is imported as "${OLD}/dbsql".\nfunc New() {}\n`,
    'README.md': `Install with go get ${OLD}/chi@v0.1.0.\nSee https://github.com/test-bench/test-bench/blob/main/README.md for the repository.\n`,
    'internal/ui/dist/app.js': `// embedded UI mentions ${OLD} verbatim and must stay byte-for-byte\n`,
    'internal/ui/dist/blob.bin': Buffer.from([0, 1, 2, 3]),
    'scripts/note.txt': 'unmanaged and does not mention the base\n',
  };
}

/** Maps every file under `root` to the SHA-256 of its bytes. */
function snapshot(root) {
  const result = {};
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else result[path.relative(root, full)] = createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
  };
  visit(root);
  return result;
}

/** Runs the CLI against `root`, capturing both streams. */
function run(root, ...argv) {
  let out = '';
  let err = '';
  const code = main(argv, { root, out: { write: (text) => { out += text; } }, err: { write: (text) => { err += text; } } });
  return { code, out, err };
}

test('moduleBaseFor appends adapters/go to a valid repository path', () => {
  assert.equal(moduleBaseFor('github.com/acme/test-bench'), 'github.com/acme/test-bench/adapters/go');
  assert.equal(moduleBaseFor('git.example.org/team/sub/repo'), 'git.example.org/team/sub/repo/adapters/go');
});

test('moduleBaseFor rejects paths that are not Go module paths', () => {
  const invalid = ['', 'acme/test-bench', 'github.com', 'https://github.com/acme/test-bench', 'github.com/acme/test-bench/', 'github.com/acme/test-bench.git',
    'github.com/acme/test bench', 'github.com/acme//test-bench', 'github.com/acme/../x', 'github.com/acme/.hidden', 'user@github.com/acme/x', 'github.com/acme/x?y=1', 'github.com/acme/v2', 'github.com/ac$me/x'];
  for (const value of invalid) assert.throws(() => moduleBaseFor(value), /./, `expected ${JSON.stringify(value)} to be rejected`);
});

test('replaceBase only matches the whole module path, not URLs or longer elements', () => {
  const text = `import "${OLD}/dbsql"\nhttps://${OLD}/x\nxx${OLD}\n${OLD}2\n${OLD}.\n${OLD}.v2\n`;
  const { result, count } = replaceBase(text, OLD, NEW);
  assert.equal(count, 2);
  assert.equal(result, `import "${NEW}/dbsql"\nhttps://${OLD}/x\nxx${OLD}\n${OLD}2\n${NEW}.\n${OLD}.v2\n`);
});

test('rewriting changes exactly the managed files and nothing else', () => {
  const root = repository(sampleFiles());
  const before = snapshot(root);
  const { code, out, err } = run(root, 'github.com/acme/test-bench');
  assert.equal(code, 0, err);
  assert.match(out, /example\.com\/old\/repo\/adapters\/go -> github\.com\/acme\/test-bench\/adapters\/go in 7 files/);
  const after = snapshot(root);
  assert.deepEqual(Object.keys(after), Object.keys(before));
  const changed = Object.keys(after).filter((file) => after[file] !== before[file]).sort();
  assert.deepEqual(changed, ['adapters/go/MODULE_PATH', 'adapters/go/README.md', 'adapters/go/chi/chi.go', 'adapters/go/chi/go.mod', 'adapters/go/go.mod', 'adapters/go/go.work', 'adapters/go/testbench/bench.go']);
  const read = (relative) => fs.readFileSync(path.join(root, 'adapters', 'go', relative), 'utf8');
  assert.equal(read('MODULE_PATH'), `${NEW}\n`);
  assert.equal(read('go.mod'), `module ${NEW}\n\ngo 1.24\n`);
  assert.match(read('go.work'), new RegExp(`${NEW} v0.1.0 => ./\\n\\t${NEW}/chi v0.1.0 => ./chi`));
  assert.match(read('chi/chi.go'), new RegExp(`import "${NEW}/testbench"`));
  // The external repository URL in prose is not a module path and stays.
  assert.match(read('README.md'), /https:\/\/github\.com\/test-bench\/test-bench\/blob\/main\/README\.md/);
  assert.equal(run(root, '--check').code, 0);
});

test('rewriting twice with the same path is a no-op', () => {
  const root = repository(sampleFiles());
  assert.equal(run(root, 'github.com/acme/test-bench').code, 0);
  const once = snapshot(root);
  const second = run(root, 'github.com/acme/test-bench');
  assert.equal(second.code, 0);
  assert.match(second.out, /already github\.com\/acme\/test-bench\/adapters\/go/);
  assert.deepEqual(snapshot(root), once);
});

test('rewriting can be repeated to a different path and back', () => {
  const root = repository(sampleFiles());
  const original = snapshot(root);
  assert.equal(run(root, 'github.com/acme/test-bench').code, 0);
  assert.equal(run(root, 'gitlab.com/group/project').code, 0);
  assert.equal(run(root, 'example.com/old/repo').code, 0);
  assert.deepEqual(snapshot(root), original);
});

test('--dry-run reports the plan and writes nothing', () => {
  const root = repository(sampleFiles());
  const before = snapshot(root);
  const { code, out } = run(root, 'github.com/acme/test-bench', '--dry-run');
  assert.equal(code, 0);
  assert.match(out, /would update adapters\/go\/go\.mod/);
  assert.match(out, /Dry run:/);
  assert.deepEqual(snapshot(root), before);
});

test('an invalid path is rejected before any file is touched', () => {
  const root = repository(sampleFiles());
  const before = snapshot(root);
  for (const value of ['github.com', 'https://github.com/acme/x', 'github.com/acme/x/']) {
    const { code, err } = run(root, value);
    assert.equal(code, 2);
    assert.notEqual(err, '');
  }
  assert.equal(run(root).code, 2);
  assert.equal(run(root, 'a.com/x', 'b.com/y').code, 2);
  assert.equal(run(root, 'a.com/x', '--unknown').code, 2);
  assert.deepEqual(snapshot(root), before);
});

test('a file the tool does not manage that names the base blocks the whole rewrite', () => {
  for (const unmanaged of ['scripts/release.sh', 'go.sum', 'go.work.sum']) {
    const root = repository({ ...sampleFiles(), [unmanaged]: `#!/bin/sh\necho ${OLD}\n` });
    const before = snapshot(root);
    const { code, err } = run(root, 'github.com/acme/test-bench');
    assert.equal(code, 1, unmanaged);
    assert.match(err, new RegExp(`${unmanaged.replace('.', '\\.')}: names`));
    assert.deepEqual(snapshot(root), before, `${unmanaged} left the tree untouched`);
  }
});

test('a go.mod with a replace directive blocks the rewrite and fails --check', () => {
  const files = sampleFiles();
  files['chi/go.mod'] += `\nreplace ${OLD} => ../\n`;
  const root = repository(files);
  const before = snapshot(root);
  const rewrite = run(root, 'github.com/acme/test-bench');
  assert.equal(rewrite.code, 1);
  assert.match(rewrite.err, /chi\/go\.mod: go\.mod must not contain a replace directive/);
  assert.deepEqual(snapshot(root), before);
  assert.equal(run(root, '--check').code, 1);
});

test('--check rejects a module line outside the recorded base', () => {
  const files = sampleFiles();
  files['chi/go.mod'] = files['chi/go.mod'].replace(`module ${OLD}/chi`, 'module example.com/other/chi');
  const { code, err } = run(repository(files), '--check');
  assert.equal(code, 1);
  assert.match(err, /module example\.com\/other\/chi is outside/);
});

test('a missing or malformed MODULE_PATH is reported', () => {
  const files = sampleFiles();
  delete files.MODULE_PATH;
  assert.equal(run(repository(files), 'github.com/acme/test-bench').code, 2);
  assert.equal(run(repository({ ...sampleFiles(), MODULE_PATH: 'example.com/old/repo\n' }), '--check').code, 2);
});

test('files are not rewritten when one write fails; originals come back', () => {
  const root = repository(sampleFiles());
  const before = snapshot(root);
  // A directory where a temporary file must go makes the second write throw.
  const target = path.join(root, 'adapters', 'go', 'chi', 'chi.go.set-go-module-path.tmp');
  fs.mkdirSync(target);
  assert.throws(() => run(root, 'github.com/acme/test-bench'));
  fs.rmSync(target, { recursive: true });
  assert.deepEqual(snapshot(root), before);
});

test('the real repository metadata is consistent: one base, no replace directives', () => {
  const { code, out, err } = run(realRoot, '--check');
  assert.equal(code, 0, err);
  assert.match(out, /consistent with .*\/adapters\/go/);
});

test('the real repository can be retargeted: a dry run plans only managed files and blocks nothing', () => {
  const before = snapshot(path.join(realRoot, 'adapters', 'go', 'chi'));
  const { code, out, err } = run(realRoot, 'github.com/acme/test-bench', '--dry-run');
  assert.equal(code, 0, err);
  const files = [...out.matchAll(/would update adapters\/go\/(\S+)/g)].map((match) => match[1]);
  assert.ok(files.includes('MODULE_PATH') && files.includes('go.work') && files.includes('chi/go.mod'));
  for (const file of files) {
    assert.ok(/(^|\/)(go\.mod|go\.work|MODULE_PATH)$|\.(go|md)$/.test(file), `${file} is a managed file type`);
    assert.ok(!file.startsWith('internal/ui/dist/') && !file.endsWith('go.sum') && !file.endsWith('go.work.sum'), `${file} must not be rewritten`);
  }
  assert.deepEqual(snapshot(path.join(realRoot, 'adapters', 'go', 'chi')), before);
});
