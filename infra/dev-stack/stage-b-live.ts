import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { readFile, writeFile, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { requireStageBStack } from './stage-b-guard.ts';
import { stageBComposeOverride, stageBLaunchSources } from './stage-b-launch.ts';

const root = new URL('../../', import.meta.url).pathname.slice(0, -1);
const id = process.env['DEV_STACK_ID'];
const directory = await requireStageBStack(id, process.env['STAGE_B_CLAIMED_ID'] ?? '',
  homedir(), root);
const serverSource = await readFile(`${root}/apps/server/src/main.ts`, 'utf8');
const modelsSource = await readFile(`${root}/apps/server/src/models-main.ts`, 'utf8');
stageBLaunchSources(serverSource, modelsSource);
const { readEnv } = await import('./config.ts');
const settings = await readEnv('settings');
assert.notEqual(settings['DEV_REAL_PROVIDER'], '1', 'Only the free model may run');
const { createDemoServer } = await import('../../apps/demo-mcp/src/server.ts');
const demo = createDemoServer();
await demo.listen({ path: `${directory}/stage-b-demo.sock` });
const execute = promisify(execFile);
const composeFile = `${directory}/stage-b-compose.json`;
const entry = 'infra/dev-stack/stage-b-entry.ts';
const override = stageBComposeOverride(root, directory, id!);
await writeFile(composeFile, JSON.stringify(override), { mode: 0o600 });
const composeArgs = ['compose', '--project-name', `opencrane-dev-${id}`,
  '--env-file', `${directory}/settings.env`, '-f', 'infra/dev-stack/compose.yaml',
  '-f', 'infra/dev-stack/compose.secondary.yaml', '-f', composeFile];
try {
  await execute('docker', [...composeArgs, 'build', 'models'], { cwd: root });
} catch {
  await demo.close();
  throw new Error('Local TLS image build failed');
}
const [pidText, started] = (await readFile(`${directory}/server.pid`, 'utf8')).split(' ');
const pid = Number(pidText);
async function fingerprint(processId: number) {
  try {
    const stat = await readFile(`/proc/${processId}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (fields[0] === 'Z') return undefined;
    return fields[19];
  } catch {
    return undefined;
  }
}
assert(started && await fingerprint(pid) === started, 'Owned server process changed');
const environment = await readFile(`/proc/${pid}/environ`, 'utf8');
const env: NodeJS.ProcessEnv = {};
for (const field of environment.split('\0')) {
  const separator = field.indexOf('=');
  if (separator > 0) env[field.slice(0, separator)] = field.slice(separator + 1);
}
env['STAGE_B_CLAIMED_ID'] = id;
assert.equal(await fingerprint(pid), started, 'Owned server process changed');
process.kill(-pid, 'SIGTERM');
for (let attempt = 0; await fingerprint(pid) === started; attempt++) {
  assert(attempt < 150, 'Owned server did not stop');
  await delay(100);
}
const log = await open(`${directory}/stage-b-server.log`, 'a', 0o600);
const child = spawn(process.execPath, ['--experimental-strip-types', entry, 'server'],
  { cwd: root, env, detached: true, stdio: ['ignore', log.fd, log.fd] });
assert(child.pid, 'Rehearsal server did not start');
await log.close();
await writeFile(`${directory}/server.pid`, `${child.pid} ${await fingerprint(child.pid)}`);
async function close() {
  child.kill('SIGTERM');
  await demo.close();
}
function failed() {
  process.exitCode = 1;
}
function stop() {
  void close().catch(failed);
}
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
try {
  await execute('docker', [...composeArgs, 'up', '-d', '--no-deps', 'models'], { cwd: root });
  for (const endpoint of [
    `http://127.0.0.1:${settings['SERVER_PORT']}/healthz`,
    `http://127.0.0.1:${settings['MODEL_READINESS_PORT']}/healthz/ready`,
  ]) {
    let ready = false;
    for (let attempt = 0; attempt < 120 && !ready; attempt++) {
      try {
        ready = (await fetch(endpoint, { signal: AbortSignal.timeout(1000) })).ok;
      } catch {
        ready = false;
      }
      if (!ready) await delay(1000);
    }
    assert(ready, 'Injected service did not become ready');
  }
  console.log('PASS complete server and models processes ready with guarded local transport');
} catch {
  await close();
  throw new Error('Local rehearsal launch failed; inspect private process logs');
}
