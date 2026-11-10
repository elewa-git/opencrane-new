import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync,
  rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { checkedImageIdentity } from './build-images.mjs';

const revision = 'a'.repeat(40);
const digest = `sha256:${'b'.repeat(64)}`;
const imageId = `sha256:${'c'.repeat(64)}`;

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
