import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { uploadComputer } from '../../apps/server/test/support/upload-computer.ts';
import { proveComputerBridge } from './bridge-proof.ts';
import { proveComputerSupervisor } from './supervisor-proof.ts';

const helperImage = `bridge-helper:${randomUUID()}`;
const fixtureImage = `bridge-fixture:${randomUUID()}`;
const packagedImage = `bridge-packaged:${randomUUID()}`;
const installationId = `sha256:${'e'.repeat(64)}`;
const containers: string[] = [];

function docker(args: string[]): string {
  const options = { encoding: 'utf8' as const, timeout: 300_000, stdio: 'pipe' as const };
  return execFileSync('/usr/bin/docker', args, options).trim();
}

function build(): void {
  docker(['build', '-q', '-f', 'infra/package/Dockerfile', '--target',
    'runner-protection', '-t', helperImage, '.']);
  const context = mkdtempSync(join(tmpdir(), 'bridge-proof-'));
  try {
    const dockerfile = `FROM ${helperImage}\nWORKDIR /app\n` +
      'RUN ln -s /app/scripts /scripts && mkdir -p /app/src\n' +
      'COPY entrypoint.ts bridge.ts /app/src/\n' +
      'CMD ["/usr/local/bin/node","--experimental-strip-types","/app/src/entrypoint.ts"]\n';
    const entrypoint = `
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
mkdirSync('/run/executor/supervisor', { recursive: true, mode: 0o700 });
const child = spawn('/usr/local/bin/node', ['--disable-sigusr1',
  '--experimental-strip-types', '/app/src/bridge.ts'], { uid: 1000, gid: 1000,
  stdio: ['ignore', 'ignore', 'ignore'] });
const stat = readFileSync('/proc/' + child.pid + '/stat', 'utf8');
const fields = stat.slice(stat.lastIndexOf(') ') + 2).trimEnd().split(' ');
writeFileSync('/run/executor/supervisor/bridge-identity',
  child.pid + ' ' + fields[19] + '\\n', { mode: 0o600 });
setInterval(() => {}, 1000);
`;
    const bridge = `
import { startServiceProtection } from '/scripts/private-memory-qualification/service-protection.ts';
await startServiceProtection('bridge');
setInterval(() => {}, 1000);
`;
    writeFileSync(join(context, 'Dockerfile'), dockerfile);
    writeFileSync(join(context, 'entrypoint.ts'), entrypoint);
    writeFileSync(join(context, 'bridge.ts'), bridge);
    docker(['build', '-q', '--network=none', '-t', fixtureImage, context]);
    docker(['buildx', 'bake', '-f', 'apps/computer/test/upload-bake.hcl',
      '--set', `computer.tags=${packagedImage}`]);
  } finally {
    rmSync(context, { recursive: true, force: true });
  }
}

function start(swap = '256m', core = '0:0'): string {
  const container = docker(['run', '-d', '--network=none', '--read-only',
    '--tmpfs', '/run', '--cap-drop=ALL', '--cap-add=SYS_PTRACE',
    '--cap-add=SETUID', '--cap-add=SETGID',
    '--memory=256m', `--memory-swap=${swap}`, `--ulimit=core=${core}`,
    fixtureImage]);
  containers.push(container);
  return container;
}

function cleanup(): void {
  for (const container of containers) {
    docker(['rm', '-f', '-v', container]);
  }
  docker(['image', 'rm', '-f', fixtureImage, helperImage, packagedImage]);
}
beforeAll(build, 310_000);
afterAll(cleanup, 60_000);

async function waitForBridge(container: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      docker(['exec', container, 'test', '-f',
        '/run/executor/supervisor/bridge-identity']);
      return;
    } catch {
      await new Promise(function pause(resolve) { setTimeout(resolve, 100); });
    }
  }
  throw new Error('bridge_fixture_missing');
}

async function provesOnlyTheBridgeGroup(): Promise<void> {
  const container = start();
  await waitForBridge(container);
  expect(await proveComputerBridge(container, installationId)).toBe(true);
  expect(await proveComputerSupervisor(container, installationId)).not.toBe(true);
  const inventory = docker(['exec', container, '/usr/local/bin/node',
    '--experimental-strip-types', '--input-type=module', '--eval',
    "import { probePrivateProcessInventory } from '/scripts/private-memory-qualification/private-processes.ts'; process.stdout.write(String(probePrivateProcessInventory()));"]);
  expect(inventory).toBe('private_process_missing');
  docker(['exec', container, 'sh', '-c',
    "printf '999999 1\\n' > /run/executor/supervisor/bridge-identity"]);
  expect(await proveComputerBridge(container, installationId)).not.toBe(true);
}
it('proves a live bridge in a separate container but leaves full qualification blocked',
  provesOnlyTheBridgeGroup, 60_000);

async function refusesSwapAllowance(): Promise<void> {
  const container = start('512m');
  await waitForBridge(container);
  expect(await proveComputerBridge(container, installationId)).toBe('swap_not_disabled');
}
it('refuses nonzero swap allowance in the computer container', refusesSwapAllowance, 60_000);

async function refusesCoreAllowance(): Promise<void> {
  const container = start('256m', '1:1');
  await waitForBridge(container);
  expect(await proveComputerBridge(container, installationId)).not.toBe(true);
}
it('refuses nonzero bridge core dump allowance', refusesCoreAllowance, 60_000);

async function provesPackagedBridge(): Promise<void> {
  const computer = await uploadComputer(true, '',
    { image: packagedImage, protected: true });
  try {
    expect(await proveComputerBridge(computer.containerId, installationId)).toBe(true);
    expect(await proveComputerSupervisor(computer.containerId, installationId)).toBe(true);
    const record = execFileSync('/usr/bin/docker', ['exec', computer.containerId,
      'cat', '/run/executor/supervisor/bridge-identity'], { encoding: 'utf8' });
    expect(record).toMatch(/^[1-9][0-9]* [1-9][0-9]*\n$/u);
  } finally {
    await computer.close();
  }
}
it('proves the packaged bridge launched by the root computer entrypoint',
  provesPackagedBridge, 120_000);
