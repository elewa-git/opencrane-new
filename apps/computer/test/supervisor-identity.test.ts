import { expect, it } from 'vitest';
import { uploadComputer } from '../../server/test/support/upload-computer.ts';

const binding = { generation: 1, podUid: 'fixture', takeoverId: 'identity-test',
  affectedTurnIds: [] };

async function refusesUncertainIdentity(fault: string) {
  const computer = await uploadComputer();
  try {
    const observer = `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const original = fs.readFileSync;
let observations = 0;
fs.readFileSync = function readObservedFile(path, ...rest) {
  const result = original(path, ...rest);
  if (path === '/proc/1/stat') {
    observations++;
    if (${JSON.stringify(fault)} === 'missing-start') return '1 (init) S';
    if (${JSON.stringify(fault)} === 'reused-pid' && observations === 2) {
      const end = result.lastIndexOf(')');
      const fields = result.slice(end + 2).split(' ');
      fields[19] = String(BigInt(fields[19]) + 1n);
      return result.slice(0, end + 2) + fields.join(' ');
    }
  }
  if (${JSON.stringify(fault)} === 'partial-uid' && String(path).endsWith('/status')) {
    return result.replace(/^Uid:.*$/m, 'Uid:\\t1000');
  }
  return result;
};
syncBuiltinESMExports();
fs.unlinkSync('/run/executor/supervisor/control.sock');
const { supervisorStop } = await import('file:///app/src/supervisor-stop.ts');
supervisorStop();
process.stdout.write('ready');
`;
    await computer.write('/workspace/identity-observer.mjs', observer);
    const start = `
import { spawn } from 'node:child_process';
const child = spawn('node', ['--experimental-strip-types', '/workspace/identity-observer.mjs'], {
  detached: true, stdio: ['ignore', 'pipe', 'ignore'],
});
function ready(bytes) {
  process.stdout.write(bytes);
  child.stdout.destroy();
  child.unref();
}
child.stdout.once('data', ready);
`;
    expect(await computer.exec('node', '--input-type=module', '-e', start)).toBe('ready');
    const request = `
import { request } from 'node:http';
function receive(response) {
  process.stdout.write(String(response.statusCode) + '\\n');
  response.pipe(process.stdout);
}
const options = { socketPath: '/run/executor/supervisor/control.sock',
  path: '/stop', method: 'POST' };
const outgoing = request(options, receive);
outgoing.end(process.argv[1]);
`;
    const result = await computer.exec('node', '--input-type=module', '-e', request,
      JSON.stringify(binding));
    expect(result).toBe('400\n{"error":"Stop proof unavailable","controlEnabled":false}');
    expect(await computer.exec('pgrep', '-x', 'Xvnc')).toMatch(/^\d+$/u);
  } finally {
    await computer.close();
  }
}
it.each(['missing-start', 'reused-pid', 'partial-uid'])(
  'refuses a root receipt when process observation has %s', refusesUncertainIdentity, 60_000);

async function checksRealAutomation(uid: number) {
  const computer = await uploadComputer();
  try {
    const launch = `
import { spawn } from 'node:child_process';
const child = spawn('/usr/bin/chromium', ['--headless', '--no-sandbox',
  '--disable-background-networking', '--remote-debugging-port=0',
  '--user-data-dir=/tmp/automation-fixture', 'about:blank'], {
  uid: ${uid}, gid: ${uid}, detached: true, stdio: ['ignore', 'ignore', 'pipe'],
  env: { ...process.env, HOME: '/tmp/automation-home' },
});
let output = '';
function ready(bytes) {
  output += bytes.toString();
  if (!output.includes('DevTools listening on')) return;
  child.stderr.off('data', ready);
  process.stdout.write('ready');
  child.stderr.destroy();
  child.unref();
}
child.stderr.on('data', ready);
`;
    expect(await computer.exec('node', '--input-type=module', '-e', launch)).toBe('ready');
    const before = await computer.exec('pgrep', '-u', String(uid), '-x', 'chromium');
    expect(before).toMatch(/\d+/u);
    const request = `
import { request } from 'node:http';
function receive(response) { response.pipe(process.stdout); }
const options = { socketPath: '/run/executor/supervisor/control.sock',
  path: '/stop', method: 'POST' };
const outgoing = request(options, receive);
outgoing.end(process.argv[1]);
`;
    const result = await computer.exec('node', '--input-type=module', '-e', request,
      JSON.stringify(binding));
    const expected = { executionQuiet: true, executionInventory: [],
      quietProof: 'unavailable', controlEnabled: false };
    expect(JSON.parse(result)).toMatchObject(expected);
    // Keep desktop automation outside the executor proof until browser closure is checked.
    const inspect = `
import { readFileSync } from 'node:fs';
let live = false;
for (const pid of process.argv[1].split('\\n')) {
  try {
    const status = readFileSync('/proc/' + pid + '/status', 'utf8');
    if (!/State:\\s+[ZX]/.test(status)) live = true;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
process.stdout.write(String(live));
`;
    expect(await computer.exec('node', '--input-type=module', '-e', inspect, before))
      .toBe(String(uid === 1002));
    expect(await computer.exec('pgrep', '-x', 'Xvnc')).toMatch(/^\d+$/u);
  } finally {
    await computer.close();
  }
}
it.each([1001, 1002])('keeps automation under UID %s separate from full quiet proof',
  checksRealAutomation, 60_000);
