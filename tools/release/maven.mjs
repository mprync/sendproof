// Maven Central packaging: builds the Java/Kotlin bindings into a Maven repository layout.
//
// pack   publishes every module to a throwaway local repository inside ctx.work (so the tracked build and
//        the adapters/java/build/repo directory are never touched), validates the POM and archive contents,
//        and copies the Maven tree into ctx.out without checksums or maven-metadata files.
// verify builds a fresh Spring Boot project that resolves the artifacts from ctx.out only, runs it and
//        checks /sendproof/ and /openapi.json. A second configuration resolves sendproof-ktor.
//
// Signing is deliberately absent: the CI publish job signs and checksums the files with gpg, so no secret
// ever reaches the Gradle build. Gradle itself is the repository's wrapper (adapters/java).

import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  isWindows, listFiles, readJson, removeDir, require, root, run, smokeServe, tempDir, which,
} from './lib.mjs';

export const title = 'Maven Central';

const GROUP = 'io.github.mprync';
const MODULES = ['sendproof-core', 'sendproof-ui', 'sendproof-jdbc', 'sendproof-logback', 'sendproof-spring-boot', 'sendproof-jpa', 'sendproof-ktor'];
/** Modules whose sources are not Java: Kotlin code, or (sendproof-ui) JavaScript resources. Their Javadoc jar is a placeholder. */
const SOURCE_EXTENSION = { 'sendproof-ktor': '.kt', 'sendproof-ui': '.js' };
/** Spring Boot version the consumer smoke test builds against; keep in step with adapters/java/gradle/libs.versions.toml. */
const SPRING_BOOT = '3.5.16';

const javaDir = join(root, 'adapters', 'java');
const gradleHome = process.env.GRADLE_USER_HOME ?? join(javaDir, '.gradle-home');

/** Major version of the `java` found at `javaBin`, or 0 when it cannot be run. */
function javaMajor(javaBin) {
  const probe = spawnSync(javaBin, ['-version'], { encoding: 'utf8', windowsHide: true });
  const match = /version "(?:1\.)?(\d+)/.exec(`${probe.stderr ?? ''}${probe.stdout ?? ''}`);
  return match ? Number(match[1]) : 0;
}

export async function available() {
  if (isWindows) {
    const javaBin = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', 'java.exe') : which('java');
    if (!javaBin || javaMajor(javaBin) < 17) return 'JDK 17 or newer is required (set JAVA_HOME)';
    return null;
  }
  // scripts/jdk.sh picks a JDK 17+ the same way every Gradle invocation below does.
  const probe = spawnSync('sh', ['-c', '. "$0" && printf %s "$JAVA_HOME"', join(javaDir, 'scripts', 'jdk.sh')], { encoding: 'utf8' });
  return probe.status === 0 && probe.stdout ? null : 'JDK 17 or newer is required (scripts/jdk.sh found none; set JAVA_HOME)';
}

/**
 * Runs the repository's Gradle wrapper. POSIX goes through scripts/gradle.sh (JDK selection); Windows calls
 * gradlew.bat with JAVA_HOME from the environment. Both use the project-local Gradle home so caches are reused.
 * `--no-daemon` keeps CI and local runs from leaving a Gradle process behind.
 */
function gradle(args, options = {}) {
  const env = { GRADLE_USER_HOME: gradleHome, ...options.env };
  const full = ['--no-daemon', ...args];
  return isWindows
    ? run(join(javaDir, 'gradlew.bat'), full, { cwd: javaDir, label: 'gradle', ...options, env })
    : run('sh', [join(javaDir, 'scripts', 'gradle.sh'), ...full], { cwd: javaDir, label: 'gradle', ...options, env });
}

/** Names of the entries in a zip/jar, read from the central directory (no zip tool needed). */
function zipNames(buffer) {
  let end = buffer.length - 22;
  while (end >= 0 && buffer.readUInt32LE(end) !== 0x06054b50) end -= 1;
  if (end < 0) throw new Error('not a zip file');
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const names = [];
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('corrupt zip central directory');
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    names.push(buffer.toString('utf8', offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

/** First top-level POM element called `name`, ignoring anything inside blocks such as dependencies. */
function pomText(xml, name) {
  const top = xml.replace(/<(dependencies|dependencyManagement|build|profiles|properties)>[\s\S]*?<\/\1>/g, '');
  return new RegExp(`<${name}>([^<]*)</${name}>`).exec(top)?.[1]?.trim();
}

/** The text between the first `<tag>` pair of a block, e.g. the `<scm>` or `<license>` element. */
function pomBlock(xml, tag) {
  return new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml)?.[1] ?? '';
}

/** Throws unless the generated POM carries everything Maven Central requires, with the stamped values. */
function checkPom(module, xml, ctx) {
  const where = `${module} POM`;
  const url = ctx.repository.url;
  const expect = (label, actual, wanted) => require(actual === wanted, `${where}: ${label} is ${JSON.stringify(actual)}, expected ${JSON.stringify(wanted)}`);
  expect('groupId', pomText(xml, 'groupId'), GROUP);
  expect('artifactId', pomText(xml, 'artifactId'), module);
  expect('version', pomText(xml, 'version'), ctx.version);
  expect('name', pomText(xml, 'name'), module);
  require(pomText(xml, 'description')?.length >= 20, `${where}: description is missing or too short`);
  expect('url', pomText(xml, 'url'), url);
  const license = pomBlock(xml, 'license');
  expect('license name', pomText(license, 'name'), ctx.metadata.license);
  expect('license url', pomText(license, 'url'), 'https://opensource.org/license/mit');
  const developer = pomBlock(xml, 'developer');
  expect('developer id', pomText(developer, 'id'), 'sendproof');
  expect('developer name', pomText(developer, 'name'), ctx.metadata.authors[0]);
  const scm = pomBlock(xml, 'scm');
  expect('scm url', pomText(scm, 'url'), url);
  expect('scm connection', pomText(scm, 'connection'), `scm:git:${url}.git`);
  require(pomText(scm, 'developerConnection')?.startsWith('scm:git:'), `${where}: scm developerConnection is missing`);
  expect('issue tracker', pomText(pomBlock(xml, 'issueManagement'), 'url'), ctx.metadata.issues);
  for (const dependency of xml.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
    if (pomText(dependency[1], 'groupId') === GROUP) {
      expect(`${pomText(dependency[1], 'artifactId')} dependency version`, pomText(dependency[1], 'version'), ctx.version);
    }
  }
}

/** Checks one module's published directory and returns nothing; throws on the first problem. */
async function checkModule(module, directory, ctx) {
  const base = `${module}-${ctx.version}`;
  const files = await readdir(directory);
  for (const suffix of ['.jar', '-sources.jar', '-javadoc.jar', '.pom', '.module']) {
    require(files.includes(`${base}${suffix}`), `${module}: ${base}${suffix} was not published`);
  }
  checkPom(module, await readFile(join(directory, `${base}.pom`), 'utf8'), ctx);

  const gradleModule = await readJson(join(directory, `${base}.module`));
  require(gradleModule.formatVersion && gradleModule.component?.version === ctx.version && gradleModule.component?.module === module,
    `${module}: ${base}.module does not describe ${GROUP}:${module}:${ctx.version}`);

  const jars = {};
  for (const suffix of ['.jar', '-sources.jar', '-javadoc.jar']) jars[suffix] = zipNames(await readFile(join(directory, `${base}${suffix}`)));
  for (const [suffix, names] of Object.entries(jars)) {
    require(names.includes('META-INF/LICENSE'), `${module}: ${base}${suffix} has no META-INF/LICENSE`);
  }
  require(jars['.jar'].some(name => name.endsWith('.class') || name.startsWith('sendproof-ui/')), `${module}: ${base}.jar is empty`);
  const sourceExtension = SOURCE_EXTENSION[module] ?? '.java';
  require(jars['-sources.jar'].some(name => name.endsWith(sourceExtension)), `${module}: ${base}-sources.jar has no ${sourceExtension} files`);
  const docs = jars['-javadoc.jar'].filter(name => !name.endsWith('/') && !name.startsWith('META-INF/'));
  require(docs.length > 0, `${module}: ${base}-javadoc.jar is empty`);
  if (!SOURCE_EXTENSION[module]) require(docs.includes('index.html'), `${module}: ${base}-javadoc.jar has no index.html`);
  if (module === 'sendproof-ui') {
    require(jars['.jar'].includes('sendproof-ui/manifest.json'), 'sendproof-ui jar must contain sendproof-ui/manifest.json');
    require(jars['.jar'].includes('sendproof-ui/app.js'), 'sendproof-ui jar must contain sendproof-ui/app.js');
  }
}

/** Files Central's publish job regenerates itself, so they are never uploaded from here. */
const regenerated = name => /^maven-metadata.*\.xml(\.(md5|sha1|sha256|sha512|asc))?$/.test(name) || /\.(md5|sha1|sha256|sha512|asc)$/.test(name);

export async function pack(ctx) {
  const repo = join(ctx.work, 'repo');
  await mkdir(repo, { recursive: true });
  await gradle([
    `-Psendproof.version=${ctx.version}`,
    `-Psendproof.repositoryUrl=${ctx.repository.url}`,
    `-Psendproof.repoDir=${repo}`,
    ...MODULES.map(module => `:${module}:publishMavenPublicationToLocalRepository`),
  ]);

  const artifactsRoot = join(repo, ...GROUP.split('.'));
  const published = (await readdir(artifactsRoot)).sort();
  require(JSON.stringify(published) === JSON.stringify([...MODULES].sort()), `Published artifacts ${published.join(', ')} differ from ${MODULES.join(', ')}`);
  for (const module of MODULES) await checkModule(module, join(artifactsRoot, module, ctx.version), ctx);

  const written = [];
  for (const file of await listFiles(repo)) {
    if (regenerated(file.split(/[\\/]/).pop())) continue;
    const target = join(ctx.out, file);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(repo, file), target);
    written.push(file.split(sep).join('/'));
  }
  ctx.log(`${MODULES.length} modules, ${written.length} files (checksums, signatures and maven-metadata are produced by the publish job)`);
  return written.sort();
}

/** Copies the consumer template into `directory`, filling in the version, Spring Boot version and repository. */
async function writeConsumer(directory, ctx) {
  const template = join(root, 'tools', 'release', 'consumers', 'maven');
  await cp(template, directory, { recursive: true });
  const values = { '@VERSION@': ctx.version, '@SPRING_BOOT@': SPRING_BOOT, '@REPOSITORY@': pathToFileURL(ctx.out).href };
  const file = join(directory, 'build.gradle.kts');
  let text = await readFile(file, 'utf8');
  for (const [key, value] of Object.entries(values)) text = text.replaceAll(key, value);
  await writeFile(file, text);
}

export async function verify(ctx) {
  const consumer = await tempDir('maven');
  try {
    await writeConsumer(consumer, ctx);
    // Resolution and compilation read ctx.out only (the consumer's repository is a file URL to it).
    await gradle(['--project-dir', consumer, 'bootJar']);

    const javaHome = (await readFile(join(consumer, 'build', 'consumer', 'java-home.txt'), 'utf8')).trim();
    const ktor = (await readFile(join(consumer, 'build', 'consumer', 'ktor-classpath.txt'), 'utf8')).split('\n');
    require(ktor.includes(`sendproof-ktor-${ctx.version}.jar`), `sendproof-ktor did not resolve (got ${ktor.join(', ')})`);
    require(ktor.includes(`sendproof-core-${ctx.version}.jar`) && ktor.some(name => name.startsWith('ktor-server-core')),
      `sendproof-ktor's transitive dependencies did not resolve (got ${ktor.join(', ')})`);

    await smokeServe({
      label: 'maven consumer',
      command: join(javaHome, 'bin', isWindows ? 'java.exe' : 'java'),
      args: ['-XX:TieredStopAtLevel=1', '-jar', join(consumer, 'build', 'libs', 'consumer.jar')],
      cwd: consumer,
    });
  } finally {
    if (!ctx.keep) await removeDir(consumer);
    else ctx.log(`kept consumer at ${consumer}`);
  }
}
