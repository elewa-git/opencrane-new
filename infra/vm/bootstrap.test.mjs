import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const image = 'node:22.23.1-bookworm-slim';
const script = '/source/infra/vm/bootstrap.sh';
const prefix = `
set -eu
printf 'ID=ubuntu\\nVERSION_ID="24.04"\\n' > /etc/os-release
`;

function container(commands, args = []) {
  const mount = `type=bind,src=${root},dst=/source,readonly`;
  const command = prefix + commands + '\nbash ' + script + ' ' + args.join(' ');
  const options = { encoding: 'utf8', timeout: 60_000 };
  return spawnSync('docker', ['run', '--rm', '--network=none', '--cap-drop=ALL',
    '--security-opt=no-new-privileges', '--mount', mount, image, 'bash', '-c', command], options);
}

function successful(result) {
  assert.equal(result.status, 0, result.stderr + result.stdout);
  return result.stdout;
}

test('shellcheck accepts bootstrap and the shared runtime helper', function checkShell() {
  execFileSync('shellcheck', ['infra/vm/bootstrap.sh', 'infra/devbox/runtime.sh'], { cwd: root });
});

test('dry run prints node protection, downloads, runtime and storage without writing', function dry() {
  const output = successful(container('', ['--dry-run']));
  for (const step of ['swapoff', 'core_pattern', 'kdump', 'sha256sum', 'runsc',
    'k3s.service', 'gvisor', 'local-path', 'agent-sandbox', 'ready']) {
    assert.ok(output.includes(step), `Missing dry-run step: ${step}`);
  }
  const checked = container(`bash ${script} --dry-run >/dev/null
    test ! -e /etc/rancher/k3s
    test ! -e /var/lib/opencrane-vm`, ['--dry-run']);
  successful(checked);
});

const refusals = [
  ['Docker binary', 'mkdir -p /usr/local/bin; touch /usr/local/bin/docker; chmod +x /usr/local/bin/docker'],
  ['Docker socket', 'mkdir -p /run; touch /run/docker.sock'],
  ['foreign Kubernetes', 'mkdir -p /etc/kubernetes'],
  ['unowned k3s', 'mkdir -p /var/lib/rancher/k3s'],
  ['foreign containerd', 'mkdir -p /run/containerd; touch /run/containerd/containerd.sock'],
  ['microk8s', 'mkdir -p /var/snap/microk8s'],
];

for (const [name, setup] of refusals) {
  test(`refuses ${name} before mutation, including in dry run`, function refuse() {
    for (const args of [[], ['--dry-run']]) {
      const result = container(setup, args);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /Refusing existing/);
      assert.doesNotMatch(result.stdout, /apt-get|swapoff|Download/);
    }
  });
}

test('refuses unsupported OS and unknown options', function invalidInput() {
  const result = container('printf "ID=debian\\nVERSION_ID=12\\n" > /etc/os-release');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Ubuntu/);
  assert.equal(container('', ['--unknown']).status, 2);
});
