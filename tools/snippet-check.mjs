// Syntax-checks every generated request sample with the toolchains installed on this machine.
//
//   node tools/snippet-check.mjs
//
// Each fixture request (plain, JSON, form, and bodies full of awkward characters) is exported in
// every language and handed to that language's own parser: `bash -n`, `node --check`,
// `python -m py_compile`, `ruby -c`, `php -l`, PowerShell's parser, `rustfmt` (syntax only),
// `gofmt -e` and `javac` (needs JDK 15+ for text blocks). A language whose tool isn't installed is
// reported as skipped, never as a pass. C# and Kotlin need a full project to compile, so they are
// not checked here. Exits 1 if any available checker rejects a sample.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatRequest, pickerFormats } from '../ui/snippets.js';

/** Requests chosen to stress each language's string escaping. */
export const fixtures = {
  get: { method: 'get', url: 'https://api.test/sendproof/payments?page=1&token=private', headers: { Authorization: 'Bearer private', Accept: 'application/json' } },
  bare: { method: 'delete', url: 'https://api.test/sendproof/payments/7', headers: {} },
  json: { method: 'post', url: 'https://api.test/sendproof/payments', headers: { 'Content-Type': 'application/json', 'X-Note': "it's \"quoted\"" },
    body: JSON.stringify({ note: 'Alice\'s "quoted" invoice\nline 2 \\ back é 😀   $schema #{x} `tick` """ \'@', items: [1, 2.5, null, true], nested: { password: 'p' } }) },
  tricky: { method: 'put', url: 'https://api.test/sendproof/x', headers: { 'Content-Type': 'application/json' },
    body: '{"a":"\\\\","b":"\\u0001","c":"\\"","d":"line\\nbreak","e":"\'\'\'","f":"$"}' },
  text: { method: 'post', url: 'https://api.test/sendproof/text', headers: { 'Content-Type': 'text/plain' }, body: 'one "two" \'three\'\n  four \\ $five #{six} `seven`\n\'@\nJSON\nBODY\n"""' },
  form: { method: 'post', url: 'https://api.test/sendproof/form', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'name=Zo%C3%AB&note=a%26b&password=secret' },
  custom: { method: 'query', url: 'https://api.test/sendproof/search', headers: { 'Content-Type': 'application/json' }, body: '[]' },
};

const run = (command, args) => spawnSync(command, args, { encoding: 'utf8' });
const has = command => run('which', [command]).status === 0;
const javaMajor = () => Number(/version "?(\d+)/.exec(run('javac', ['-version']).stderr + run('javac', ['-version']).stdout)?.[1] ?? 0);

/** How to check each format: the file name and the command (given the path), or why it can't run. */
const checkers = {
  curl: { file: 'sample.sh', available: () => has('bash'), command: path => ['bash', ['-n', path]] },
  fetch: { file: 'sample.mjs', available: () => has('node'), command: path => ['node', ['--check', path]] },
  python: { file: 'sample.py', available: () => has('python3'), command: path => ['python3', ['-I', '-m', 'py_compile', path]] },
  ruby: { file: 'sample.rb', available: () => has('ruby'), command: path => ['ruby', ['-c', path]] },
  php: { file: 'sample.php', available: () => has('php'), command: path => ['php', ['-l', path]] },
  powershell: {
    file: 'sample.ps1', available: () => has('pwsh'),
    command: path => ['pwsh', ['-NoProfile', '-Command', `$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${path}', [ref]$null, [ref]$e); if ($e.Count) { $e | ForEach-Object { $_.Message }; exit 1 }`]],
  },
  rust: { file: 'sample.rs', available: () => has('rustfmt'), command: path => ['rustfmt', ['--edition', '2021', '--emit', 'stdout', path]] },
  go: { file: 'sample.go', available: () => has('gofmt'), command: path => ['gofmt', ['-e', path]] },
  // Java text blocks need JDK 15+; the sample's class is Main, so the file must be Main.java.
  java: { file: 'Main.java', available: () => has('javac') && javaMajor() >= 15, command: path => ['javac', ['-d', join(path, '..', 'out'), path]] },
};

/** Runs every check; returns `{ checked: Map<format, count>, skipped: string[], failures: string[] }`. */
export function checkSnippets() {
  const directory = mkdtempSync(join(tmpdir(), 'snippet-check-'));
  const checked = new Map();
  const skipped = [];
  const failures = [];
  try {
    for (const { id } of pickerFormats) {
      const checker = checkers[id];
      if (!checker) { skipped.push(`${id} (needs a full project)`); continue; }
      if (!checker.available()) { skipped.push(`${id} (tool not installed${id === 'java' ? ' or older than JDK 15' : ''})`); continue; }
      for (const [name, request] of Object.entries(fixtures)) {
        const path = join(directory, `${id}-${name}`, checker.file);
        run('mkdir', ['-p', join(path, '..')]);
        writeFileSync(path, formatRequest(id, request, []));
        const [command, args] = checker.command(path);
        const result = run(command, args);
        if (result.status !== 0) failures.push(`${id} / ${name}: ${(result.stderr || result.stdout).trim().split('\n').slice(0, 4).join(' | ')}`);
        checked.set(id, (checked.get(id) ?? 0) + 1);
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  return { checked, skipped, failures };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { checked, skipped, failures } = checkSnippets();
  for (const [id, count] of checked) console.log(`${failures.some(line => line.startsWith(id + ' ')) ? 'FAIL' : 'ok  '} ${id}: ${count} samples`);
  for (const line of skipped) console.log(`skip ${line}`);
  for (const line of failures) console.error(`FAILED ${line}`);
  process.exit(failures.length ? 1 : 0);
}
