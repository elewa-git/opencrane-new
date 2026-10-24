import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { test } from 'node:test';
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
  const restoredDispatch = restoredWatch.replace('network: stageBNetwork, acknowledged,',
    'acknowledged,');
  assert.equal(restoredDispatch, models);
}
test('only discovery, watch and dispatch change in the complete entrypoints',
  preserveProductionWiring);

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
  assert.equal(call?.namespace, 'mcp__demo');
  assert.equal(call?.name, 'change_delivery_slot');
  assert.equal(call?.arguments, '{"quoteId":"DEMO-001","slot":"afternoon"}');
  const completed = [...input, { type: 'function_call_output', output: 'recorded' }];
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
