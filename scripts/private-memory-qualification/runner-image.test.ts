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
