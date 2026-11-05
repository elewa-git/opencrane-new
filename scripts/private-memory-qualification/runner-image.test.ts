import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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

function run(source: string, memorySwap = '256m', core = '0:0'): string {
  const name = `runner-protection-test-${randomUUID()}`;
  const options = { encoding: 'utf8' as const, timeout: 15_000 };
  try {
    const args = ['run', '--name', name, '--network=none', '--read-only',
      '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=32',
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
function acceptsRestricted(): void {
  expect(run(probe)).toBe('true');
}
it('measures the image-owned runner inside its restricted container', acceptsRestricted);
function refusesSwap(): void {
  expect(run(probe, '512m')).toBe('false');
}
it('refuses actual non-zero cgroup swap allowance', refusesSwap);
function refusesCore(core: string): void {
  expect(run(probe, '256m', core)).toBe('false');
}
it.each(['0:1', '1:1'])('refuses actual core limits %s', refusesCore);
function measuresActualProcess(): void {
  const source = `import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    import { spawnSync } from 'node:child_process';
    import { runnerProtected } from '${directory}/runner-protection.ts';
    const require = createRequire(import.meta.url);
    const helper = require('${directory}/runner-protection.node');
    assert.equal(helper.check(), false);
    assert.equal(runnerProtected(), true);
    assert.equal(helper.check(), true);
    const child = spawnSync(process.execPath, ['-e',
      "process.stdout.write(String(require('${directory}/runner-protection.node').check()))"]);
    assert.equal(child.status, 0);
    assert.equal(child.stdout.toString(), 'false');
    assert.equal(runnerProtected(), true);
    process.stdout.write('measured');`;
  expect(run(source)).toBe('measured');
}
it('measures this process and refuses the unprotected process after exec', measuresActualProcess);
