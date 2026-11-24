import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';
import './operator-contract.test.mjs';

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

function checkShell() {
  const files = ['infra/vm/bootstrap.sh', 'infra/devbox/runtime.sh', 'infra/devbox/setup.sh'];
  const checked = spawnSync('shellcheck', files, { cwd: root, encoding: 'utf8' });
  successful(checked);
}

function dry() {
  const result = container('', ['--dry-run']);
  const output = successful(result);
  for (const step of ['swapoff', 'core_pattern', 'kdump', 'sha256sum', 'runsc',
    'k3s.service', 'gvisor', 'local-path', 'agent-sandbox', 'ready']) {
    assert.ok(output.includes(step), `Missing dry-run step: ${step}`);
  }
  const checked = container(`bash ${script} --dry-run >/dev/null
    test ! -e /etc/rancher/k3s
    test ! -e /var/lib/opencrane-vm`, ['--dry-run']);
  successful(checked);
}

const refusedPaths = [
  '/run/docker.sock', '/var/run/docker.sock', '/etc/docker', '/var/lib/docker',
  '/etc/kubernetes', '/var/snap/microk8s', '/etc/rancher/rke2',
  '/run/containerd/containerd.sock', '/etc/containerd', '/var/lib/containerd',
  '/var/lib/kubelet', '/etc/rancher/k3s', '/var/lib/rancher/k3s', '/usr/local/bin/k3s',
  '/etc/systemd/system/k3s.service', '/etc/systemd/system/k3s-agent.service',
];
const refusedBinaries = ['docker', 'dockerd', 'kubelet', 'kubeadm', 'microk8s', 'containerd'];
const refusals = [];
for (const path of refusedPaths) {
  refusals.push([path, `mkdir -p "$(dirname "${path}")"; touch "${path}"`]);
}
for (const binary of refusedBinaries) {
  const setup = `touch /usr/local/bin/${binary}; chmod +x /usr/local/bin/${binary}`;
  refusals.push([binary, setup]);
}
refusals.push(['unknown ownership marker', `mkdir -p /var/lib/opencrane-vm
  printf 'unknown' > /var/lib/opencrane-vm/managed-k3s`]);

function registerRefusal(name, setup) {
  function refuse() {
    for (const args of [[], ['--dry-run'], ['--apply']]) {
      const commands = fakeHost + setup + `
        snapshot_host /tmp/before
        status=0
        bash ${script} ${args.join(' ')} >/tmp/output 2>/tmp/error || status=$?
        test "$status" -eq 1
        grep -q 'Refusing existing' /tmp/error
        ! grep -Eq 'apt-get|swapoff|Download|Write ' /tmp/output
        test ! -e /fixture-calls
        snapshot_host /tmp/after
        cmp /tmp/before /tmp/after
        exit 0`;
      successful(container(commands, args));
    }
  }
  test(`refuses ${name} before mutation, including in dry run`, refuse);
}

function invalidInput() {
  const result = container('printf "ID=debian\\nVERSION_ID=12\\n" > /etc/os-release');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Ubuntu/);
  const invalidArguments = [['--unknown'], ['--apply', '--dry-run'],
    ['--dry-run', '--apply'], ['--apply', '--apply'], ['--apply', 'extra']];
  for (const args of invalidArguments) {
    const result = container(fakeHost, args);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Usage:.*--dry-run.*--apply/u);
    assert.doesNotMatch(result.stdout, /Step:|Write /u);
  }
}

const fakeHost = `
snapshot_host() {
  find /etc /var/lib /usr/local /run -printf '%y %m %u %g %p %l\\n' > "$1"
  find /etc /var/lib /usr/local /run -type f -exec /usr/bin/sha256sum {} + >> "$1"
  sort -o "$1" "$1"
}
mkdir -p /fixture-bin
export PATH=/fixture-bin:$PATH
for program in apt-get swapoff sysctl systemctl tar kexec; do
  printf '#!/bin/sh\\nprintf called >> /fixture-calls\\nexit 0\\n' > /fixture-bin/$program
  chmod +x /fixture-bin/$program
done
printf '#!/bin/sh\\ncat >/dev/null\\nexit 0\\n' > /fixture-bin/sha256sum
cat > /fixture-bin/curl <<'CURL'
#!/bin/bash
while [ "$#" -gt 0 ]; do
  if [ "$1" = --output ]; then destination=$2; shift; fi
  shift
done
printf '#!/bin/sh\\ncat >/dev/null\\nexit 0\\n' > "$destination"
printf 'image: registry.k8s.io/agent-sandbox/agent-sandbox-controller:v1.0.4\\n' >> "$destination"
CURL
chmod +x /fixture-bin/*
`;

function defaultLeavesHostUnchanged() {
  const commands = fakeHost + `
    snapshot_host /tmp/before
    bash ${script} >/tmp/output
    if [ -e /fixture-calls ]; then
      printf 'No-argument bootstrap invoked a mutating host command\\n' >&2
      exit 1
    fi
    snapshot_host /tmp/after
    cmp /tmp/before /tmp/after
  `;
  successful(container(commands, ['--dry-run']));
}

function idempotent() {
  const commands = fakeHost + `
    bash ${script} --apply >/dev/null
    test -s /fixture-calls
    test -f /var/lib/opencrane-vm/managed-k3s
    mkdir -p /var/lib/kubelet
    find /etc/rancher /etc/systemd/system /etc/sysctl.d /var/lib/opencrane-vm \\
      -type f -exec /usr/bin/sha256sum {} + | sort > /tmp/before
    bash ${script} --apply >/dev/null
    find /etc/rancher /etc/systemd/system /etc/sysctl.d /var/lib/opencrane-vm \\
      -type f -exec /usr/bin/sha256sum {} + | sort > /tmp/after
    cmp /tmp/before /tmp/after
    grep -q 'LimitCORE=0' /etc/systemd/system/k3s.service
    grep -q 'io.containerd.runsc.v1' \\
      /var/lib/rancher/k3s/agent/etc/containerd/config-v3.toml.tmpl
  `;
  const result = container(commands, ['--dry-run']);
  successful(result);
}

function replacedBinary() {
  const commands = fakeHost + `
    bash ${script} --apply >/dev/null
    rm /fixture-bin/sha256sum
    printf 'foreign binary' > /usr/local/bin/k3s
  `;
  const result = container(commands, ['--apply']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Refusing existing changed k3s binary/);
  assert.doesNotMatch(result.stdout, /Step:|Write /u);
}

test('shellcheck accepts bootstrap and the shared runtime helper', checkShell);
test('dry run prints node protection, downloads, runtime and storage without writing', dry);
test('refuses unsupported OS and unknown options', invalidInput);
test('no arguments leave the simulated host unchanged', defaultLeavesHostUnchanged);
test('explicit apply changes the simulated host and permits an identical rerun', idempotent);
test('an ownership marker cannot approve a replaced k3s binary', replacedBinary);
for (const [name, setup] of refusals) {
  registerRefusal(name, setup);
}
