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
fs.readFileSync = function(path, ...rest) {
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
child.stdout.once('data', bytes => {
  process.stdout.write(bytes); child.stdout.destroy(); child.unref();
});
`;
    expect(await computer.exec('node', '--input-type=module', '-e', start)).toBe('ready');
    const request = `
import { request } from 'node:http';
const outgoing = request({ socketPath: '/run/executor/supervisor/control.sock',
  path: '/stop', method: 'POST' }, response => {
  process.stdout.write(String(response.statusCode) + '\\n');
  response.pipe(process.stdout);
});
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
