import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const templatePath = new URL('../sandbox-template.json', import.meta.url);
const template = JSON.parse(readFileSync(templatePath, 'utf8'));
const container = template.spec.podTemplate.spec.containers[0];
const capabilities = container.securityContext.capabilities;
assert.deepEqual(capabilities.drop, ['ALL']);
assert.deepEqual(capabilities.add, ['SETUID', 'SETGID', 'CHOWN', 'DAC_OVERRIDE']);
const containerName = `private-capabilities-${process.pid}`;
const sourceDirectory = fileURLToPath(new URL('../src', import.meta.url));
const driverPath = fileURLToPath(new URL('private-capabilities-driver.mjs', import.meta.url));
const image = process.env.COMPUTER_TEST_IMAGE ?? 'ocn-computer-runtime';
const args = ['run', '-d', '--name', containerName, '--cap-drop', 'ALL'];
for (const capability of capabilities.add) {
  args.push('--cap-add', capability);
}
args.push('--tmpfs', '/home/private:rw,size=16m,mode=0711',
  '-v', `${sourceDirectory}:/app/src:ro`, '-v', `${driverPath}:/test/driver.mjs:ro`,
  '-e', 'GATEWAY=http://127.0.0.1:3000', '-e', 'MODEL=gpt-6.1-sol', image);
try {
  execFileSync('docker', args, { stdio: 'pipe' });
  const command = ['exec', containerName, 'node',
    '--experimental-strip-types', '/test/driver.mjs'];
  const options = { timeout: 60_000, stdio: ['ignore', 'pipe', 'inherit'] };
  const result = execFileSync('docker', command, options);
  assert.match(result.toString(), /PASS private turn with template capabilities/u);
  process.stdout.write(result);
} finally {
  execFileSync('docker', ['rm', '-f', containerName], { stdio: 'ignore' });
}
