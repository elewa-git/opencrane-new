import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { exchangeRemote, prepareRemote } from '@opencrane/models';
import { discoverInventory } from '../../apps/server/test/inventory.ts';
import { remoteRequest } from '../../apps/server/src/integrations/remote.ts';
import { demoRemoteFixture, demoLocator } from './test/demo-remote.ts';
import { requireStageBStack } from './stage-b-guard.ts';
import { checkStageBApproval } from './stage-b-evidence.ts';
import { approvalEvidence } from './test/stage-b-evidence.ts';

async function refuseSlotsBeforeSettings() {
  const home = await mkdtemp(`${tmpdir()}/stage-b-slot-`);
  const directory = `${home}/.config/opencrane/dev-stack-1`;
  try {
    for (const requested of [undefined, '', 'owner', '3', '2']) {
      await assert.rejects(requireStageBStack(requested, '1', home, '/worktree'),
        /Secondary slot mismatch/u);
    }
    await mkdir(directory, { recursive: true });
    await writeFile(`${directory}/stack-owner`, 'worktree=/foreign\npid=1\n');
    await assert.rejects(requireStageBStack('1', '1', home, '/worktree'), /Foreign stack/u);
    // Leave settings absent: ownership must be checked before reading configuration.
    await writeFile(`${directory}/stack-owner`, 'worktree=/worktree\npid=1\n');
    assert.equal(await requireStageBStack('1', '1', home, '/worktree'), directory);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
test('wrong, owner and foreign slots refuse before settings', refuseSlotsBeforeSettings);

async function localDemoRoundTrip() {
  const fixture = await demoRemoteFixture();
  try {
    async function inventoryCall(method: 'server/discover' | 'tools/list') {
      const reply = await remoteRequest(demoLocator, method, undefined,
        fixture.network, AbortSignal.timeout(5000));
      return reply.resultJson;
    }
    const inventory = await discoverInventory(inventoryCall);
    assert.equal(inventory.tools?.length, 2);
    for (const tool of inventory.tools ?? []) {
      assert.equal(tool.costCents, 0);
      assert.equal(tool.reviewed, false);
    }
    const before = await callDemo(fixture, inventory.schemaDigest, 'read_fixture_quote');
    assert.equal(before.effectCount, 0);
    await callDemo(fixture, inventory.schemaDigest, 'change_delivery_slot');
    const after = await callDemo(fixture, inventory.schemaDigest, 'read_fixture_quote');
    assert.deepEqual(after, { quoteId: 'DEMO-001', amountCents: 12500,
      slot: 'afternoon', effectCount: 1 });
    // Confirm fixture state through another read, not the write's HTTP response.
    assert.equal(fixture.connections(), 5);
    assert.deepEqual(fixture.pinned, Array(5).fill('93.184.216.34'));
  } finally {
    await fixture.close();
  }
}
test('real demo discovery and TLS calls retain zero costs and read back one effect',
  localDemoRoundTrip);

async function callDemo(fixture: Awaited<ReturnType<typeof demoRemoteFixture>>,
  revision: string, name: string) {
  const signal = AbortSignal.timeout(5000);
  const target = await prepareRemote(demoLocator, fixture.network, signal);
  const args = { quoteId: 'DEMO-001',
    ...(name === 'change_delivery_slot' ? { slot: 'afternoon' } : {}) };
  const params = { name, arguments: args,
    _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } };
  const raw = JSON.stringify({ jsonrpc: '2.0', id: 'local-check', method: 'tools/call', params });
  const headers = { 'content-type': 'application/json', 'mcp-protocol-version': '2026-07-28',
    'mcp-method': 'tools/call', 'mcp-name': name, 'x-opencrane-mcp-revision': revision };
  const reply = await exchangeRemote(target, raw, headers, fixture.network, signal, 1048576);
  const data = JSON.parse(reply.data.toString()) as {
    result: { structuredContent: { effectCount: number } } };
  return data.result.structuredContent;
}

async function refuseAddresses() {
  const fixture = await demoRemoteFixture();
  try {
    await assert.rejects(prepareRemote('https://foreign.example.test/', fixture.network,
      AbortSignal.timeout(5000)), /Demo host refused/u);
    for (const answers of [['127.0.0.1'], ['93.184.216.34', '10.0.0.1']]) {
      fixture.setAnswers(answers);
      await assert.rejects(prepareRemote(demoLocator, fixture.network,
        AbortSignal.timeout(5000)), /unsafe_address/u);
    }
    assert.equal(fixture.connections(), 0);
  } finally {
    await fixture.close();
  }
}
test('private and mixed DNS and other hosts never open a socket', refuseAddresses);

async function refuseTlsAndRedirects() {
  for (const options of [{ wrongHostname: true }, { redirect: true }]) {
    const fixture = await demoRemoteFixture(options);
    try {
      const result = remoteRequest(demoLocator, 'server/discover', undefined,
        fixture.network, AbortSignal.timeout(5000));
      const expected = options.redirect ? /redirect_refused/u : /network_refused/u;
      await assert.rejects(result, expected);
      assert.equal(fixture.connections(), 1);
    } finally {
      await fixture.close();
    }
  }
}
test('bad certificates and redirects refuse without another connection', refuseTlsAndRedirects);

async function refuseTransportBypasses() {
  const fixture = await demoRemoteFixture();
  function receive() { assert.fail('No response expected'); }
  function bypassCertificate() { return undefined; }
  function publicLookup(_host: unknown, _options: unknown,
    done: (error: null, address: string, family: number) => void) {
    done(null, '93.184.216.34', 4);
  }
  try {
    const options = { servername: 'mcp.example.test', rejectUnauthorized: true,
      agent: false as const, family: 4, lookup: publicLookup };
    for (const patch of [{ servername: 'foreign.example.test' },
      { rejectUnauthorized: false }, { agent: undefined }, { lookup: undefined },
      { checkServerIdentity: bypassCertificate }, { socketPath: '/tmp/stage-b-denied.sock' }]) {
      function requestUnsafe() {
        fixture.network.request!(new URL(demoLocator), { ...options, ...patch }, receive);
      }
      assert.throws(requestUnsafe, /Demo TLS settings refused/u);
    }
    const target = { endpoint: new URL(demoLocator), address: { address: '127.0.0.1', family: 4 } };
    await assert.rejects(exchangeRemote(target, '{}', {}, fixture.network,
      AbortSignal.timeout(5000), 1024), /network_refused/u);
    assert.equal(fixture.connections(), 0);
  } finally {
    await fixture.close();
  }
}
test('the adapter requires TLS verification, SNI, no pooling and the checked public pin',
  refuseTransportBypasses);

function rejectFalseEvidence() {
  checkStageBApproval(approvalEvidence());
  const failures = [
    function unpublished(data: ReturnType<typeof approvalEvidence>) { data.policy.published = false; },
    function noReview(data: ReturnType<typeof approvalEvidence>) { data.policy.reviewRevision = 2; },
    function oldReceipt(data: ReturnType<typeof approvalEvidence>) {
      data.policy.configurationObservation!.changeRef = 'another-publication';
    },
    function wrongPublication(data: ReturnType<typeof approvalEvidence>) {
      data.publicationCommandId = 'another-publication';
    },
    function oldGeneration(data: ReturnType<typeof approvalEvidence>) { data.gateway.generation = 2; },
    function wrongProcess(data: ReturnType<typeof approvalEvidence>) {
      data.gateway.processRef = '00000000-0000-4000-8000-000000000002';
    },
    function missingGrant(data: ReturnType<typeof approvalEvidence>) { data.grants.pop(); },
    function staleIam(data: ReturnType<typeof approvalEvidence>) {
      data.grants[0]!.receipt.projection.iam = 'applying';
    },
    function wrongGrant(data: ReturnType<typeof approvalEvidence>) {
      data.grants[0]!.receipt.commandId = 'another-grant';
    },
    function foreignAssistant(data: ReturnType<typeof approvalEvidence>) {
      data.grants[1]!.command.granteeId = 'another-assistant';
    },
    function prematureWrite(data: ReturnType<typeof approvalEvidence>) {
      data.waiting.effectCount = 1;
    },
    function duplicateWrite(data: ReturnType<typeof approvalEvidence>) { data.after.effectCount = 2; },
    function differentTurn(data: ReturnType<typeof approvalEvidence>) { data.replyTurnId = 'other'; },
    function toolCharge(data: ReturnType<typeof approvalEvidence>) {
      Reflect.set(data, 'toolChargedCents', 1);
    },
    function toolHold(data: ReturnType<typeof approvalEvidence>) {
      Reflect.set(data, 'toolReservedCents', 1);
    },
  ];
  for (const mutate of failures) {
    const evidence = approvalEvidence();
    mutate(evidence);
    function check() { checkStageBApproval(evidence); }
    assert.throws(check, /Approval evidence refused/u, mutate.name);
  }
}
test('incomplete publication, grants, approval, effects or spending cannot pass', rejectFalseEvidence);

function keepEvidenceErrorsPrivate() {
  const syntheticSecret = 'synthetic-private-value';
  function check() { checkStageBApproval({ secret: syntheticSecret }); }
  assert.throws(check, { message: 'Approval evidence refused' });
}
test('invalid evidence errors contain no supplied values', keepEvidenceErrorsPrivate);
