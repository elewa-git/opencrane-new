import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync,
  rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { checkedImageIdentity } from './build-images.mjs';

const revision = 'a'.repeat(40);
const digest = `sha256:${'b'.repeat(64)}`;
const imageId = `sha256:${'c'.repeat(64)}`;
const codexSha256 = '1748767b230ebfc3d4ab7e4e254920d0c0ad9691fd8c11f190e7d44511a4a92e';

function imageRecordBindsSource() {
  const metadata = {
    'containerimage.digest': digest,
    'containerimage.config.digest': imageId,
  };
  const inspection = {
    Id: imageId,
    Config: { Labels: { 'org.opencontainers.image.revision': revision } },
  };
  assert.deepEqual(checkedImageIdentity(metadata, inspection, revision, imageId), {
    manifestDigest: digest,
    configurationDigest: imageId,
  });
  const docker29Metadata = { 'containerimage.digest': digest };
  const docker29Inspection = { ...inspection, Id: digest };
  assert.deepEqual(checkedImageIdentity(docker29Metadata, docker29Inspection,
    revision, imageId), { manifestDigest: digest, configurationDigest: imageId });
  function wrongConfiguration() {
    checkedImageIdentity(metadata, { ...inspection,
      Id: `sha256:${'d'.repeat(64)}` }, revision, imageId);
  }
  function wrongRevision() {
    checkedImageIdentity(metadata, { ...inspection,
      Config: { Labels: {} } }, revision, imageId);
  }
  function wrongManifest() {
    checkedImageIdentity({ ...metadata,
      'containerimage.digest': 'latest' }, inspection, revision, imageId);
  }
  assert.throws(wrongConfiguration, /manifest and configuration/u);
  assert.throws(wrongRevision, /revision/u);
  assert.throws(wrongManifest, /manifest/u);
}

function fakeBuildFixture(exitCommand) {
  const home = mkdtempSync(join(tmpdir(), 'qualification-images-test-'));
  const slot = join(home, '.config/opencrane/dev-stack-1');
  const bin = join(home, 'bin');
  mkdirSync(slot, { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(slot, 'stack-owner'), `worktree=${resolve('.')}\n`);
  const git = `#!/bin/sh
case "$1" in
  rev-parse) echo '${revision}' ;;
  status) exit 0 ;;
  archive) tar -cf "$4" --files-from /dev/null ;;
  *) exit 2 ;;
esac
`;
  writeFileSync(join(bin, 'git'), git, { mode: 0o755 });
  const dockerLog = join(home, 'docker-commands');
  const docker = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
${exitCommand}
`;
  writeFileSync(join(bin, 'docker'), docker, { mode: 0o755 });
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`,
    FAKE_DOCKER_LOG: dockerLog };
  return { home, slot, dockerLog, env };
}

function assertNoPublication(fixture, template) {
  const attempts = readdirSync(join(fixture.slot, 'qualification-images'));
  assert.equal(attempts.length, 1);
  const attemptDirectory = join(fixture.slot, 'qualification-images', attempts[0]);
  assert.ok(!readdirSync(attemptDirectory).includes('images.json'));
  const commands = readFileSync(fixture.dockerLog, 'utf8');
  assert.match(commands, /^buildx build /u);
  assert.doesNotMatch(commands, /^(push|tag)\b/mu);
  assert.equal(readFileSync('apps/computer/sandbox-template.json', 'utf8'), template);
}

const buildArgs = ['scripts/private-memory-qualification/build-images.mjs',
  '--id', '1', '--revision', revision];

function failedBuildWithholdsRecord() {
  const fixture = fakeBuildFixture('exit 42');
  const template = readFileSync('apps/computer/sandbox-template.json', 'utf8');
  const result = spawnSync(process.execPath, buildArgs,
    { env: fixture.env, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assertNoPublication(fixture, template);
  rmSync(fixture.home, { recursive: true, force: true });
}

async function cancelledBuildWithholdsRecord() {
  const fixture = fakeBuildFixture('sleep 30');
  const template = readFileSync('apps/computer/sandbox-template.json', 'utf8');
  const child = spawn(process.execPath, buildArgs,
    { env: fixture.env, stdio: 'ignore' });
  let started = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(fixture.dockerLog)) {
      started = true;
      break;
    }
    await delay(20);
  }
  assert.ok(started, 'The fake Docker build started');
  const exit = once(child, 'close');
  child.kill('SIGTERM');
  const [exitCode] = await exit;
  assert.equal(exitCode, 1);
  assertNoPublication(fixture, template);
  rmSync(fixture.home, { recursive: true, force: true });
}

test('the image record binds the manifest to the inspected configuration and source',
  imageRecordBindsSource);
test('a failed build leaves no completed record or publication command',
  failedBuildWithholdsRecord);
test('cancelling a build leaves no completed record or publication command',
  cancelledBuildWithholdsRecord);

const validationFiles = [
  'apps/computer/collect-licences.py',
  'apps/computer/check-licences.py',
  'infra/package/check-licences.py',
  'infra/package/image-layers.test.py',
];

function replaceFixtureCall(source, original, replacement) {
  assert.ok(source.includes(original), `Builder fixture could not find ${original}`);
  return source.replace(original, replacement);
}

function fixtureBuilderSource(worktree, signalPoint) {
  const builderPath = new URL('./build-images.mjs', import.meta.url);
  let source = readFileSync(builderPath, 'utf8');
  // Keep the real validation and completion callers. Replace only expensive build steps.
  const fakeBuild = `
async function fixtureBuildImage() {
  for (const name of ${JSON.stringify(validationFiles)}) {
    await writeFile(join(worktree, name), 'edited worktree file');
  }
  return { manifestDigest: '${digest}', configurationDigest: '${imageId}', archive: 'image.tar' };
}
`;
  source = replaceFixtureCall(source, 'const cancellation = new AbortController();',
    `const cancellation = new AbortController();${fakeBuild}`);
  source = replaceFixtureCall(source, 'await checkedSource(plan.revision);',
    'await Promise.resolve();');
  source = replaceFixtureCall(source, 'const slotDirectory = await checkedSlot(plan.slot);',
    'const slotDirectory = process.env.FIXTURE_SLOT;');
  source = replaceFixtureCall(source,
    'const source = await extractSource(plan.revision, attemptDirectory);',
    'const source = process.env.FIXTURE_ARCHIVE;');
  source = replaceFixtureCall(source,
    'await buildImage(source, { ...plan.computer, revision: plan.revision }, attemptDirectory)',
    'await fixtureBuildImage()');
  source = replaceFixtureCall(source,
    'await buildImage(source, { ...plan.package, revision: plan.revision }, attemptDirectory)',
    'await fixtureBuildImage()');
  source = replaceFixtureCall(source, 'await prepareLicenceTools(attemptDirectory)',
    '{ syft: process.env.FIXTURE_SYFT, osiPath: process.env.FIXTURE_OSI }');
  if (signalPoint === 'after-link') {
    source = replaceFixtureCall(source, 'await link(temporaryPath, recordPath);',
      "await link(temporaryPath, recordPath);\n    process.kill(process.pid, 'SIGTERM');"
        + '\n    await new Promise(setImmediate);');
  } else if (signalPoint === 'after-write') {
    source = replaceFixtureCall(source,
      "    if (signal.aborted) throw new Error('Image build cancelled');",
      "    cancelBuild();\n"
        + "    if (signal.aborted) throw new Error('Image build cancelled');");
  }
  const builder = join(worktree, 'scripts/private-memory-qualification/build-images.mjs');
  mkdirSync(join(worktree, 'scripts/private-memory-qualification'), { recursive: true });
  writeFileSync(builder, source);
  return builder;
}

function validationFixture(signalPoint) {
  const home = mkdtempSync(join(tmpdir(), 'qualification-callers-test-'));
  const worktree = join(home, 'worktree');
  const archive = join(home, 'archive');
  const slot = join(home, 'slot');
  const bin = join(home, 'bin');
  for (const directory of [worktree, archive]) {
    for (const name of validationFiles) {
      const file = join(directory, name);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, directory === archive ? 'archived file' : 'original worktree file');
    }
    writeFileSync(join(directory, 'relative-inventory.txt'),
      directory === archive ? 'archived inventory' : 'worktree inventory');
    writeFileSync(join(directory, 'relative-layer.txt'),
      directory === archive ? 'archived layer' : 'worktree layer');
  }
  mkdirSync(slot);
  mkdirSync(bin);
  const builder = fixtureBuilderSource(worktree, signalPoint);
  const fakeCommand = join(bin, 'fixture-command.mjs');
  const commandSource = `#!/usr/bin/env node
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { basename } from 'node:path';

const command = basename(process.argv[1]);
const args = process.argv.slice(2);
const entry = { command, args, cwd: process.cwd() };
function isNativeRunner(arg) {
  return arg.endsWith('native-persistence.ts');
}
if (command === 'docker' && args.includes('notices')) {
  entry.input = readFileSync(0, 'utf8');
  process.stdout.write('{}');
} else if (command === 'docker' && args.some(isNativeRunner)) {
  process.stdout.write('{"result":"unknown"}');
  process.exitCode = 1;
} else if (command === 'docker' && args.includes('sha256sum')) {
  process.stdout.write('${codexSha256}  codex');
} else if (command === 'python3') {
  const checker = args[0];
  entry.contents = readFileSync(checker, 'utf8');
  entry.inventory = readFileSync('relative-inventory.txt', 'utf8');
  entry.layer = readFileSync('relative-layer.txt', 'utf8');
} else if (command === 'syft') {
  const output = args[3].slice('syft-json='.length);
  const tag = args[1].slice('docker:'.length);
  const scan = { source: { type: 'image', metadata: {
    imageID: '${imageId}', repoDigests: [tag + '@${digest}'] } } };
  writeFileSync(output, JSON.stringify(scan));
}
appendFileSync(process.env.FIXTURE_LOG, JSON.stringify(entry) + '\\n');
`;
  writeFileSync(fakeCommand, commandSource, { mode: 0o755 });
  for (const command of ['docker', 'python3', 'syft']) {
    symlinkSync(fakeCommand, join(bin, command));
  }
  const log = join(home, 'commands.jsonl');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`,
    FIXTURE_SLOT: slot, FIXTURE_ARCHIVE: archive, FIXTURE_SYFT: join(bin, 'syft'),
    FIXTURE_OSI: join(home, 'osi.json'), FIXTURE_LOG: log };
  return { home, worktree, archive, slot, builder, log, env };
}

function parseCommandEntry(line) {
  return JSON.parse(line);
}

function runValidationFixture(signalPoint) {
  const fixture = validationFixture(signalPoint);
  try {
    const args = [fixture.builder, '--id', '1', '--revision', revision];
    const result = spawnSync(process.execPath, args, { env: fixture.env, encoding: 'utf8' });
    const attempts = readdirSync(join(fixture.slot, 'qualification-images'));
    assert.equal(attempts.length, 1);
    const attempt = join(fixture.slot, 'qualification-images', attempts[0]);
    const lines = readFileSync(fixture.log, 'utf8').trim().split('\n');
    const entries = lines.map(parseCommandEntry);
    return { fixture, result, attempt, entries };
  } catch (error) {
    rmSync(fixture.home, { recursive: true, force: true });
    throw error;
  }
}

function isNoticeCall(entry) {
  return entry.command === 'docker' && entry.input;
}

function isPythonCall(entry) {
  return entry.command === 'python3';
}

function validationUsesArchivedRevision() {
  const { fixture, result, entries } = runValidationFixture();
  try {
    assert.equal(result.status, 0, result.stderr);
    const notice = entries.find(isNoticeCall);
    assert.equal(notice.input, 'archived file');
    const pythonCalls = entries.filter(isPythonCall);
    assert.equal(pythonCalls.length, 3);
    for (const name of validationFiles) {
      const editedFile = join(fixture.worktree, name);
      assert.equal(readFileSync(editedFile, 'utf8'), 'edited worktree file');
    }
    for (const [index, name] of validationFiles.slice(1).entries()) {
      const call = pythonCalls[index];
      assert.equal(call.args[0], join(fixture.archive, name));
      assert.equal(call.cwd, fixture.archive);
      assert.equal(call.contents, 'archived file');
      assert.equal(call.inventory, 'archived inventory');
      assert.equal(call.layer, 'archived layer');
    }
  } finally {
    rmSync(fixture.home, { recursive: true, force: true });
  }
}

function cancellationDuringCompletionRemovesPublication() {
  for (const signalPoint of ['after-write', 'after-link']) {
    const { fixture, result, attempt } = runValidationFixture(signalPoint);
    try {
      assert.equal(result.status, 1, `${signalPoint}: ${result.stderr}`);
      assert.match(result.stderr, /Image build cancelled/u);
      assert.equal(existsSync(join(attempt, 'images.json')), false);
      assert.equal(existsSync(join(attempt, 'images.json.pending')), false);
    } finally {
      rmSync(fixture.home, { recursive: true, force: true });
    }
  }
}

test('real validation callers use archived files and working directory after a build edit',
  validationUsesArchivedRevision);
test('main cancels before and after linking and removes both record files',
  cancellationDuringCompletionRemovesPublication);
