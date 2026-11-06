import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const helperPath = 'scripts/ci/base-image.mjs';
const digestPath = 'apps/computer/test/base-image-digest.txt';
const inputsPath = 'apps/computer/test/base-image-inputs.txt';
const imageName = 'ghcr.io/elewa-git/opencrane-ci-computer-base';
const digest = `sha256:${'a'.repeat(64)}`;
const inputPaths = [
  '.dockerignore',
  'apps/computer/apt.lock',
  'apps/computer/tool-user.c',
  'apps/computer/test/upload-base.Dockerfile',
  'spikes/s0-1b-proxy-gvisor/package.json',
  'spikes/s0-1b-proxy-gvisor/package-lock.json',
];

function copyFixtureFile(root, path) {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(join(repositoryRoot, path), destination);
}

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'ci-base-image-'));
  copyFixtureFile(root, helperPath);
  for (const path of inputPaths) copyFixtureFile(root, path);
  mkdirSync(dirname(join(root, digestPath)), { recursive: true });
  writeFileSync(join(root, digestPath), '');
  writeFileSync(join(root, inputsPath), '');
  return root;
}

function runHelper(root, argumentsList = []) {
  return spawnSync(process.execPath, [join(root, helperPath), ...argumentsList], {
    cwd: root,
    encoding: 'utf8',
  });
}

function recordCurrentImage(root) {
  const hash = runHelper(root, ['hash']);
  assert.equal(hash.status, 0, hash.stderr);
  assert.match(hash.stdout, /^sha256:[0-9a-f]{64}$/u);
  writeFileSync(join(root, digestPath), `${digest}\n`);
  writeFileSync(join(root, inputsPath), `${hash.stdout}\n`);
}

function fixtureTest(name, run) {
  function runFixtureTest() {
    const root = makeFixture();
    try {
      run(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  test(name, runFixtureTest);
}

function removeIndent(line) {
  return line.slice(10);
}

function buildStep() {
  const workflow = readFileSync(join(repositoryRoot, '.github/workflows/ci.yml'), 'utf8');
  const match = workflow.match(
    /- name: Build the upload test computer\n\s+run: \|\n([\s\S]*?)(?=\n\s+- name:)/u,
  );
  assert.ok(match, 'CI build step is present');
  const lines = match[1].split('\n');
  const commands = lines.map(removeIndent);
  return commands.join('\n');
}

function executeCiBuildStep(root, inspectLabel = '', inspectStatus = '0') {
  const fakeBin = join(root, 'fake-bin');
  mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, 'docker'), `#!/bin/sh
printf '%s\\n' "$*" >> "$DOCKER_LOG"
if [ "$1 $2 $3" = 'buildx imagetools inspect' ]; then
  printf '%s\\n' "$INSPECT_LABEL"
  exit "$INSPECT_STATUS"
fi
`, {
    mode: 0o755,
  });
  const dockerLog = join(root, 'docker.log');
  const result = spawnSync('sh', ['-eu', '-c', buildStep()], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      DOCKER_LOG: dockerLog,
      INSPECT_LABEL: inspectLabel,
      INSPECT_STATUS: inspectStatus,
    },
  });
  let commands = '';
  if (existsSync(dockerLog)) commands = readFileSync(dockerLog, 'utf8');
  return { result, commands };
}

function runCiBuildStep(root, inspectLabel = '', inspectStatus = '0') {
  const execution = executeCiBuildStep(root, inspectLabel, inspectStatus);
  assert.equal(execution.result.status, 0, execution.result.stderr);
  return execution.commands;
}

fixtureTest('an empty digest selects the source build', (root) => {
  const result = runHelper(root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.match(runCiBuildStep(root), /^buildx bake /u);
});

fixtureTest('a valid digest with matching inputs selects the saved image', (root) => {
  recordCurrentImage(root);
  const expectedHash = readFileSync(join(root, inputsPath), 'utf8').trim();
  const result = runHelper(root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${imageName}@${digest}`);
  const command = runCiBuildStep(root, expectedHash);
  assert.match(command, /^buildx imagetools inspect /u);
  assert.match(command, /buildx build /u);
  assert.match(command, /--build-arg COMPUTER_BASE=ghcr\.io/u);
  assert.match(command, /--build-arg COMPUTER_APT_BASE=ghcr\.io/u);
});

fixtureTest('a different image label selects the source build', (root) => {
  recordCurrentImage(root);
  const commands = runCiBuildStep(root, `sha256:${'b'.repeat(64)}`);
  assert.match(commands, /^buildx imagetools inspect /u);
  assert.match(commands, /buildx bake /u);
  assert.doesNotMatch(commands, /buildx build --load/u);
});

fixtureTest('a missing image label selects the source build', (root) => {
  recordCurrentImage(root);
  const commands = runCiBuildStep(root);
  assert.match(commands, /^buildx imagetools inspect /u);
  assert.match(commands, /buildx bake /u);
  assert.doesNotMatch(commands, /buildx build --load/u);
});

fixtureTest('a registry inspection error selects the source build', (root) => {
  recordCurrentImage(root);
  const commands = runCiBuildStep(root, '', '1');
  assert.match(commands, /^buildx imagetools inspect /u);
  assert.match(commands, /buildx bake /u);
  assert.doesNotMatch(commands, /buildx build --load/u);
});

fixtureTest('an invalid digest fails before the build', (root) => {
  writeFileSync(join(root, digestPath), 'sha256:bad\n');
  const result = runHelper(root);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /must contain one full sha256 digest/u);
  const execution = executeCiBuildStep(root);
  assert.notEqual(execution.result.status, 0);
  assert.equal(execution.commands, '');
});

fixtureTest('changed launcher source selects the source build with the same digest', (root) => {
  recordCurrentImage(root);
  writeFileSync(join(root, 'apps/computer/tool-user.c'), '\n/* changed */\n', { flag: 'a' });
  const result = runHelper(root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.match(runCiBuildStep(root), /^buildx bake /u);
});

test('the saved base skips both snapshot stages', () => {
  const dockerfile = readFileSync(join(repositoryRoot, 'apps/computer/Dockerfile'), 'utf8');
  const runtimeStart = dockerfile.indexOf('FROM ${COMPUTER_APT_BASE} AS runtime');
  assert.ok(runtimeStart > 0);
  const fallback = dockerfile.slice(0, runtimeStart);
  const runtime = dockerfile.slice(runtimeStart);
  assert.match(fallback, /COPY --from=launcher-build \/tool-user/u);
  assert.doesNotMatch(runtime, /snapshot\.debian\.org|apt-get|launcher-build/u);

  const savedBase = readFileSync(join(repositoryRoot, 'apps/computer/test/upload-base.Dockerfile'), 'utf8');
  assert.match(savedBase, /COPY apps\/computer\/apt\.lock/u);
  assert.match(savedBase, /COPY --from=launcher-build \/tool-user/u);
});
