import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, it } from 'vitest';

const imageTag = `runner-protection-test:${randomUUID()}`;
const directory = '/app/scripts/private-memory-qualification';
function build(): void {
  const options = { timeout: 300_000, stdio: 'pipe' as const };
  execFileSync('/usr/bin/docker', ['build', '-q', '-f', 'infra/package/Dockerfile',
    '--target', 'runner-protection', '-t', imageTag, '.'], options);
}
function cleanup(): void {
  const options = { stdio: 'pipe' as const };
  spawnSync('/usr/bin/docker', ['image', 'rm', '-f', imageTag], options);
}
beforeAll(build, 310_000);
afterAll(cleanup);

function run(source: string, memorySwap = '256m', core = '0:0', identityChange = false): string {
  const name = `runner-protection-test-${randomUUID()}`;
  const options = { encoding: 'utf8' as const, timeout: 15_000 };
  try {
    const capabilities = identityChange ? ['--cap-add=SETUID'] : [];
    const args = ['run', '--name', name, '--network=none', '--read-only',
      '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=32',
      ...capabilities,
      '--memory=256m', `--memory-swap=${memorySwap}`, `--ulimit=core=${core}`,
      '--cpus=0.5', imageTag, 'nice', '-n', '10', 'node', '--experimental-strip-types',
      '--input-type=module', '--eval', source];
    const result = spawnSync('/usr/bin/docker', args, options);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    return result.stdout.trim();
  } finally {
    execFileSync('/usr/bin/docker', ['rm', '-f', '-v', name], options);
  }
}
const probe = `import { probeContainer } from '${directory}/container-probe.ts';
  process.stdout.write(String(probeContainer()));`;
function refusesUnmeasuredProcessGroups(): void {
  const source = `import assert from 'node:assert/strict';
    import { probePrivateProcessInventory, readProcessIdentity } from
      '${directory}/private-processes.ts';
    const identity = readProcessIdentity(process.pid);
    assert.equal(identity.pid, process.pid);
    assert.equal(identity.executable, process.execPath);
    assert.equal(probePrivateProcessInventory(), 'private_process_missing');
    process.stdout.write('refused');`;
  expect(run(source)).toBe('refused');
}
it('refuses unmeasured private processes in a restricted container',
  refusesUnmeasuredProcessGroups, 30_000);

function checksLiveServices(): void {
  const source = `
    import assert from 'node:assert/strict';
    import { spawn } from 'node:child_process';
    import { once } from 'node:events';
    import { readProcessIdentity, checkLiveService } from
      '${directory}/private-processes.ts';
    const services = [];
    async function start(name) {
      const script = "import { startServiceProtection } from " +
        "'${directory}/service-protection.ts';" +
        "await startServiceProtection('" + name + "');" +
        "process.on('SIGUSR1', () => {" +
        "process.seteuid(1000); process.stdout.write('changed\\\\n'); });" +
        "process.stdout.write('ready\\\\n');" +
        "setInterval(() => {}, 1000);";
      const child = spawn('/usr/bin/prlimit', ['--core=0:0', '--',
        '/usr/local/bin/node', '--experimental-strip-types',
        '--input-type=module', '--eval', script], { stdio: ['ignore', 'pipe', 'ignore'] });
      services.push(child);
      await once(child.stdout, 'data');
      return child;
    }
    try {
      const server = await start('serverDelivery');
      const bridge = await start('bridge');
      const serverIdentity = readProcessIdentity(server.pid);
      const bridgeIdentity = readProcessIdentity(bridge.pid);
      assert.equal(checkLiveService('serverDelivery', serverIdentity), true);
      assert.equal(checkLiveService('bridge', bridgeIdentity), true);
      const reusedPid = { ...serverIdentity,
        startTime: String(Number(serverIdentity.startTime) + 1) };
      assert.equal(checkLiveService('serverDelivery', reusedPid),
        'private_process_identity_changed');
      for (const changed of [
        { executable: '/other/node' }, { uid: serverIdentity.uid + 1 },
        { cgroup: '0::/other\\n' }, { containerIdentity: 'pid:[1]' },
      ]) {
        assert.equal(checkLiveService('serverDelivery', { ...serverIdentity, ...changed }),
          'private_process_identity_changed');
      }
      assert.equal(checkLiveService('serverDelivery', bridgeIdentity),
        'private_process_identity_changed');
      assert.equal(checkLiveService('bridge', serverIdentity),
        'private_process_identity_changed');
      server.kill('SIGUSR1');
      await once(server.stdout, 'data');
      assert.notEqual(checkLiveService('serverDelivery', serverIdentity), true);
      server.kill('SIGKILL');
      await once(server, 'exit');
      assert.notEqual(checkLiveService('serverDelivery', serverIdentity), true);
      assert.equal(checkLiveService('bridge', bridgeIdentity), true);
      bridge.kill('SIGKILL');
      await once(bridge, 'exit');
      assert.notEqual(checkLiveService('bridge', bridgeIdentity), true);
      process.stdout.write('services refused when missing');
    } finally {
      for (const child of services) child.kill('SIGKILL');
    }
  `;
  expect(run(source)).toBe('services refused when missing');
}
it('checks two live protected processes and refuses each missing process',
  checksLiveServices, 30_000);
function checksRestricted(): void {
  const pattern = readFileSync('/proc/sys/kernel/core_pattern', 'utf8');
  const privileged = readFileSync('/proc/sys/fs/suid_dumpable', 'utf8');
  let expected = 'true';
  if (pattern.startsWith('|') && privileged !== '0\n') {
    expected = 'core_helper_enabled';
  }
  expect(run(probe)).toBe(expected);
}
it('checks the restricted runner and the actual host core settings', checksRestricted, 30_000);
function refusesSwap(): void {
  expect(run(probe, '512m')).toBe('swap_not_disabled');
}
it('refuses actual non-zero cgroup swap allowance', refusesSwap, 30_000);
function refusesCore(core: string): void {
  expect(run(probe, '256m', core)).toBe('core_limit_not_zero');
}
it.each(['0:1', '1:1'])('refuses actual core limits %s', refusesCore, 30_000);
function measuresActualProcess(): void {
  const source = `import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    import { spawnSync } from 'node:child_process';
    import { runnerProtected } from '${directory}/runner-protection.ts';
    const require = createRequire(import.meta.url);
    const helper = require('${directory}/runner-protection.node');
    assert.equal(helper.check(), 'process_dumpable');
    assert.equal(runnerProtected(), true);
    assert.equal(helper.check(), true);
    const child = spawnSync(process.execPath, ['-e',
      "process.stdout.write(String(require('${directory}/runner-protection.node').check()))"]);
    assert.equal(child.status, 0);
    assert.equal(child.stdout.toString(), 'process_dumpable');
    assert.equal(runnerProtected(), true);
    process.stdout.write('measured');`;
  expect(run(source)).toBe('measured');
}
it('measures this process and refuses the unprotected process after exec', measuresActualProcess,
  30_000);
function refusesIdentityChange(): void {
  const source = `import assert from 'node:assert/strict';
    import { readFileSync } from 'node:fs';
    import { runnerProtected } from '${directory}/runner-protection.ts';
    assert.equal(runnerProtected(), true);
    const privileged = readFileSync('/proc/sys/fs/suid_dumpable', 'utf8');
    let expected = 'process_dumpable';
    if (privileged === '0\\n') {
      expected = 'process_identity_changed';
    }
    process.seteuid(1000);
    assert.equal(runnerProtected(), expected);
    process.stdout.write('refused');`;
  expect(run(source, '256m', '0:0', true)).toBe('refused');
}
it('remeasures dumpability after the actual runner changes identity', refusesIdentityChange, 30_000);
