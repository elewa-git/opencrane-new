import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import type { startDecision } from '@opencrane/models';
import { checkStageBApproval } from './stage-b-evidence.ts';
import { approvalEvidence } from './test/stage-b-evidence.ts';

const execute = promisify(execFile);
const root = new URL('../../', import.meta.url);

async function refuseWrongSlot() {
  const options = { cwd: root, env: { PATH: process.env['PATH'],
    HOME: '/missing-stage-b-home', DEV_STACK_ID: 'owner', STAGE_B_CLAIMED_ID: 'owner' } };
  function refused(error: unknown) {
    const failure = error as { stderr: string };
    assert.match(failure.stderr, /Secondary slot mismatch/u);
    assert.doesNotMatch(failure.stderr, /OIDC|DATABASE_URL|NATS_URL/u);
    return true;
  }
  for (const name of ['stage-b-entry.ts', 'stage-b-live.ts']) {
    const launch = new URL(name, import.meta.url);
    async function start() {
      await execute(process.execPath, ['--experimental-strip-types', launch.pathname, 'server'],
        options);
    }
    await assert.rejects(start, refused);
  }
}
test('the launch entry refuses the owner before loading settings or services', refuseWrongSlot);

async function preserveProductionWiring() {
  const { stageBLaunchSources } = await import('./stage-b-launch.ts');
  const server = await readFile(new URL('apps/server/src/main.ts', root), 'utf8');
  const models = await readFile(new URL('apps/server/src/models-main.ts', root), 'utf8');
  const sources = stageBLaunchSources(server, models);
  assert.equal(sources.server.replace('discovery: stageBNetwork', 'discovery: {}'), server);
  const restoredWatch = sources.models.replace('requireDispatchLeader, stageBNetwork);',
    'requireDispatchLeader);');
  const restoredDispatch = restoredWatch.replace('remoteNetwork: stageBNetwork, acknowledged,',
    'acknowledged,');
  assert.equal(restoredDispatch, models);
}
test('only discovery, watch and dispatch change in the complete entrypoints',
  preserveProductionWiring);

async function suppliesDispatchNetwork() {
  const { stageBLaunchSources } = await import('./stage-b-launch.ts');
  const server = await readFile(new URL('apps/server/src/main.ts', root), 'utf8');
  const models = await readFile(new URL('apps/server/src/models-main.ts', root), 'utf8');
  const sources = stageBLaunchSources(server, models);
  const declaration = /const dispatchOptions = (\{[^;]+\});/u.exec(sources.models);
  assert(declaration?.[1], 'The complete models entrypoint must supply dispatch options');
  const stageBNetwork = {};
  function acknowledged() {
    return null;
  }
  function requireDispatchLeader() {
    return Promise.resolve();
  }
  function requireCurrent() {
    return;
  }
  const watch = { requireCurrent };
  const context = { stageBNetwork, acknowledged, mcpRoutes: [], requireDispatchLeader, watch };
  const options = runInNewContext(`(${declaration[1]})`, context) as
    NonNullable<Parameters<typeof startDecision>[6]>;
  assert.equal(options.remoteNetwork, stageBNetwork);
}
test('the complete models entrypoint supplies the dispatch service transport',
  suppliesDispatchNetwork);

async function mountsOnlyRehearsalFiles() {
  const launch = await import('./stage-b-launch.ts');
  assert('stageBComposeOverride' in launch, 'The launcher must supply its rehearsal mounts');
  const home = await mkdtemp(`${tmpdir()}/stage-b-mounts-`);
  const directory = `${home}/.config/opencrane/dev-stack-1`;
  const worktree = root.pathname.slice(0, -1);
  function respond(_request: unknown, response: import('node:http').ServerResponse) {
    response.end('local demo reached');
  }
  const server = createServer(respond);
  try {
    await mkdir(`${directory}/personal-keys`, { recursive: true });
    await writeFile(`${directory}/stack-owner`, `worktree=${worktree}\n`);
    await writeFile(`${directory}/personal-keys/private`, 'must stay outside models');
    server.listen(`${directory}/stage-b-demo.sock`);
    await once(server, 'listening');
    const prepare = launch.stageBComposeOverride as
      (root: string, directory: string, id: string) =>
        { services: { models: { volumes: string[] } } };
    const override = prepare(worktree, directory, '1');
    const args = ['run', '--rm', '--network', 'none', '-e', `HOME=${home}`,
      '-v', `${worktree}:${worktree}:ro`];
    for (const mount of override.services.models.volumes) args.push('-v', mount);
    const script = `
      import assert from 'node:assert/strict';
      import { access, appendFile } from 'node:fs/promises';
      import { get } from 'node:http';
      import { requireStageBStack } from '${worktree}/infra/dev-stack/stage-b-guard.ts';
      const directory = await requireStageBStack('1', '1', process.env.HOME, '${worktree}');
      await assert.rejects(access(directory + '/personal-keys/private'));
      await assert.rejects(appendFile(directory + '/stack-owner', 'changed'));
      const reply = await new Promise(function exchange(resolve, reject) {
        get({ socketPath: directory + '/stage-b-demo.sock', path: '/' }, function received(response) {
          let body = '';
          response.on('data', function chunk(value) { body += value; });
          response.on('end', function finished() { resolve(body); });
        }).on('error', reject);
      });
      assert.equal(reply, 'local demo reached');
    `;
    args.push('node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3',
      'node', '--experimental-strip-types', '--input-type=module', '-e', script);
    await execute('docker', args);
  } finally {
    server.close();
    await rm(home, { recursive: true, force: true });
  }
}
test('models reads its claim and reaches the demo without mounting private keys',
  mountsOnlyRehearsalFiles);

async function refuseMissingInjection() {
  const { stageBLaunchSources } = await import('./stage-b-launch.ts');
  const server = await readFile(new URL('apps/server/src/main.ts', root), 'utf8');
  const models = await readFile(new URL('apps/server/src/models-main.ts', root), 'utf8');
  const cases = [
    [server.replace('discovery: {}', 'discovery: unavailable'), models],
    [server, models.replace('silo, requireDispatchLeader);', 'silo, unavailable);')],
    [server, models.replace('{ acknowledged, routes:', '{ routes:')],
    [server + '\ndiscovery: {}', models],
  ];
  for (const [serverSource, modelsSource] of cases) {
    function prepare() {
      stageBLaunchSources(serverSource!, modelsSource!);
    }
    assert.throws(prepare, /Required network injection unavailable/u);
  }
}
test('missing or ambiguous network injection refuses the whole launch', refuseMissingInjection);

function refuseUnprovedWrite() {
  const directWrite = approvalEvidence();
  Reflect.deleteProperty(directWrite, 'records');
  function checkDirectWrite() {
    checkStageBApproval(directWrite);
  }
  assert.throws(checkDirectWrite);
  const earlyWrite = approvalEvidence();
  earlyWrite.records.dispatch.event.time = '2026-10-23T10:00:19Z';
  function checkEarlyWrite() {
    checkStageBApproval(earlyWrite);
  }
  assert.throws(checkEarlyWrite);
}
test('one fixture effect without approval records or before approval never qualifies',
  refuseUnprovedWrite);

async function deterministicCalls() {
  const { stageBModelCall } = await import('./stage-b-model.ts');
  const tools = [{ type: 'namespace', name: 'mcp__demo',
    tools: [{ name: 'read_fixture_quote' }, { name: 'change_delivery_slot' }] }];
  const input = [{ type: 'message', role: 'user', content: 'STAGE_B_WRITE' }];
  const call = stageBModelCall({ input, tools });
  assert(call && 'arguments' in call);
  assert.equal(call?.namespace, 'mcp__demo');
  assert.equal(call?.name, 'change_delivery_slot');
  assert.equal(call?.arguments, '{"quoteId":"DEMO-001","slot":"afternoon"}');
  const result = { type: 'function_call_output', call_id: call?.call_id, output: 'recorded' };
  const completed = [...input, result];
  assert.equal(stageBModelCall({ input: completed, tools }), undefined);
  const read = [{ type: 'message', role: 'user', content: 'STAGE_B_READ' }];
  assert.equal(stageBModelCall({ input: read, tools })?.name, 'read_fixture_quote');
  function missingTool() {
    stageBModelCall({ input, tools: [] });
  }
  assert.throws(missingTool, /Reviewed demo tool was not offered/u);
}
test('the free model calls only an offered demo tool and never repeats after its result',
  deterministicCalls);
