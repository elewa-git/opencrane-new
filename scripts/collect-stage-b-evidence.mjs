import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { connectEventStore } from '@opencrane/event-store';
import { toolPolicySchema } from '@opencrane/protocol';
import { isToolPolicyAvailable } from '@opencrane/projections';
import { captureWaitingApproval } from '../infra/dev-stack/stage-b-capture.ts';
import {
  createStageBCollector, collectStageBApprovalResponse, collectStageBRecords,
} from '../infra/dev-stack/stage-b-collector.ts';
import { readStageBQuote } from '../infra/dev-stack/stage-b-readback.ts';
import { requireStageBStack } from '../infra/dev-stack/stage-b-guard.ts';
import { checkStageBApproval } from '../infra/dev-stack/stage-b-evidence.ts';

const root = resolve(import.meta.dirname, '..');
const claimedId = process.env['STAGE_B_CLAIMED_ID'] ?? '';
const directory = await requireStageBStack(process.env['DEV_STACK_ID'], claimedId, homedir(), root);
const { readEnv } = await import('../infra/dev-stack/config.ts');
const settings = await readEnv('settings');
const origin = settings['ORIGIN'];
const silo = settings['SILO_ID'];
const output = process.argv[2];
assert(output, 'Supply a new evidence directory containing publication.json');
const saved = JSON.parse(await readFile(`${output}/publication.json`, 'utf8'));
const serverId = saved.serverId;
assert.equal(typeof serverId, 'string');
const collector = createStageBCollector(output);
const { results, record } = collector;
const gitOptions = { cwd: root, encoding: 'utf8' };
const sourceOutput = execFileSync('git', ['rev-parse', 'HEAD'], gitOptions);
const source = sourceOutput.trim();
record('source', source);
record('status', 'PARTIAL');
record('serverId', serverId);
record('publication', saved);
record('failedSteps', []);
record('browserErrors', []);
record('approvalResponses', []);
const browser = await chromium.launch({ headless: true });
const contextOptions = {
  storageState: `${directory}/stage-b-browser-state.json`, viewport: { width: 1280, height: 900 },
};
const context = await browser.newContext(contextOptions);
const page = await context.newPage();
page.setDefaultTimeout(45000);
const events = await connectEventStore(await readEnv('command'));
let start = 0;
let conversationId = '';

function pageFailed(error) {
  record('browserErrors', [...results.browserErrors, error.message]);
}

function responseObserved(response) {
  const reading = collectStageBApprovalResponse(collector, response);
  void reading.catch(collectionFailed);
}

function collectionFailed(error) {
  process.exitCode = 1;
  console.error('FAIL saving approval response: ' + String(error));
}

page.on('pageerror', pageFailed);
page.on('response', responseObserved);

async function get(name, path) {
  const response = await page.request.get(origin + path);
  const body = await response.text();
  const original = { path, status: response.status(), body };
  record(`${name}Response`, original);
  assert.equal(response.status(), 200);
  return record(name, JSON.parse(body));
}

async function readPolicy() {
  const path = `/api/org/integrations/${serverId}/tools`;
  const observed = await get('policy', path);
  const policy = toolPolicySchema.parse(observed);
  return record('policy', policy);
}

async function capture(name) {
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate('document.fonts.ready');
    const addresses = page.getByText(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu);
    const options = {
      path: `${output}/${name}-${width}.png`, fullPage: true, mask: [addresses],
    };
    await page.screenshot(options);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

async function readback(label) {
  const revision = results.policy.catalogue.schemaDigest;
  return readStageBQuote(collector, `${directory}/stage-b-demo.sock`, revision, label);
}

async function collectRecords(name, subject, accept) {
  return collectStageBRecords(collector, name, events.store, subject, silo, accept);
}

function everyRecord() {
  return true;
}

function related(row) {
  return row.sequence > start && row.event.data.conversationId === conversationId;
}

function later(row) {
  return row.sequence > start;
}

async function collect() {
  if (conversationId) {
    await collectRecords('chatRecords', `conversation-${conversationId}`, everyRecord);
    function closed(row) {
      return row.event.type === 'conversation.closed';
    }
    await collectRecords('participationRecords', `participation-${conversationId}`, closed);
  } else {
    record('chatRecords', []);
  }
  await collectRecords('decisionRecords', 'decision-*', related);
  const ids = new Set();
  function belongs(row) {
    const data = row.event.data;
    if (row.event.type === 'tool.approval_requested' && related(row)) {
      ids.add(data.approvalId);
    }
    return ids.has(data.approvalId);
  }
  await collectRecords('approvalRecords', 'approval-*', belongs);
  await collectRecords('budgetRecords', `budget-${silo}`, later);
  await collectRecords('mcpRecords', `mcp-${serverId}`, everyRecord);
  await collectRecords('gatewayRecords', `gateway-config-${silo}`, everyRecord);
}

async function send(text) {
  const composer = page.getByRole('textbox', { name: 'Message your agent', exact: true });
  await composer.fill(text);
  await composer.press('Enter');
  for (let attempt = 0; attempt < 120; attempt++) {
    const location = new URL(page.url());
    conversationId = location.searchParams.get('conversation') ?? '';
    if (conversationId) {
      record('conversationId', conversationId);
      return;
    }
    await delay(500);
  }
  throw new Error('Real chat did not get a conversation id');
}

async function waitForTurn(after, allowApproval = false) {
  for (let attempt = 0; attempt < 120; attempt++) {
    await collect();
    function terminal(row) {
      const terminalTypes = ['agent.turn_failed', 'agent.turn_completed'];
      return row.sequence > after && terminalTypes.includes(row.event.type);
    }
    const finished = results.chatRecords.find(terminal);
    if (finished) return finished;
    if (allowApproval && results.approvalRecords.length) return undefined;
    await delay(1000);
  }
  throw new Error('Turn did not reach its expected state');
}

function one(type, records) {
  function matching(row) {
    return row.event.type === type;
  }
  const found = records.filter(matching);
  assert.equal(found.length, 1, 'Expected one original ' + type);
  return found[0];
}

function readDispatch(row) {
  const data = row.event.data;
  return row.event.type === 'tool.dispatch_recorded' &&
    data.toolName === 'read_fixture_quote' && data.outcome === 'responded';
}

function writeDispatch(row) {
  return row.event.type === 'tool.dispatch_recorded' &&
    row.event.data.toolName === 'change_delivery_slot';
}

function checkCosts() {
  let modelReservedCents = 0;
  let modelChargedCents = 0;
  const modelReservations = new Set();
  for (const row of results.budgetRecords) {
    if (row.event.type !== 'budget.reserved') continue;
    const data = row.event.data;
    assert.equal(data.modelCall?.conversationId, conversationId,
      'Every new reservation must be identified as this chat model call');
    modelReservations.add(data.reservationId);
    modelReservedCents += data.amountCents;
  }
  for (const row of results.budgetRecords) {
    if (row.event.type !== 'budget.settled') continue;
    assert(modelReservations.has(row.event.data.reservationId));
    modelChargedCents += row.event.data.settledCents;
  }
  const costs = {
    modelReservedCents, modelChargedCents, toolReservedCents: 0, toolChargedCents: 0,
    basis: 'Every reservation and settlement belongs to a model call; reviewed tools cost zero.',
  };
  record('costs', costs);
}

function checkApproval(writeEnd) {
  const approvalRequest = one('tool.approval_requested', results.approvalRecords);
  const writes = results.decisionRecords.filter(writeDispatch);
  assert.equal(writes.length, 1);
  const dispatch = writes[0];
  function dispatchDecision(row) {
    return row.event.type === 'decision.recorded' &&
      row.event.data.requestId === dispatch.event.data.requestId;
  }
  const decision = results.decisionRecords.find(dispatchDecision);
  const observation = results.policy.configurationObservation;
  const gateway = {
    generation: observation.generation, recordDigest: observation.recordDigest,
    configDigest: observation.configDigest, processRef: observation.processRef,
    outcome: 'loaded', observedAt: observation.observedAt,
  };
  const records = {
    request: approvalRequest,
    approvalDecision: one('approval.decided', results.approvalRecords),
    approvalUse: one('approval.used', results.approvalRecords),
    dispatchDecision: decision, dispatch,
  };
  const proof = {
    policy: results.policy, rehearsedAt: new Date().toISOString(), conversationId,
    callId: dispatch.event.data.callId, records,
    publicationCommandId: results.policy.publication.commandId, gateway, grants: results.grants,
    before: results.before.value, waiting: results.waiting.value, after: results.after.value,
    turnId: approvalRequest.event.data.turnId, replyTurnId: writeEnd.event.data.turnId,
    requesterId: results.personal.memberId, assistantId: results.personal.assistantId,
    approval: {
      decision: 'approve', decidedBy: results.personal.memberId,
      turnId: approvalRequest.event.data.turnId,
    },
    toolReservedCents: 0, toolChargedCents: 0,
  };
  record('proof', proof);
  checkStageBApproval(proof);
  record('checker', 'PASS');
}

async function readJourney() {
  await page.goto(origin + '/workspace');
  const composer = page.getByRole('textbox', { name: 'Message your agent', exact: true });
  await composer.waitFor();
  await page.keyboard.press('Control+n');
  const draftLabel = page.getByText('Draft', { exact: true });
  await draftLabel.waitFor();
  await send('STAGE_B_READ: read the synthetic demo quote with the reviewed read_fixture_quote tool.');
  const readEnd = await waitForTurn(start);
  await capture('read-chat');
  await page.reload();
  await composer.waitFor();
  await capture('read-chat-reloaded');
  assert.equal(readEnd?.event.type, 'agent.turn_completed', 'Read turn must complete');
  assert(results.decisionRecords.some(readDispatch), 'Read tool must dispatch through the gateway');
  const reply = 'Quote DEMO-001: 12500 euro cents, morning delivery. Recorded effects: 0.';
  const replyText = page.getByText(reply, { exact: true });
  await replyText.waitFor();
  record('read', 'PASS');
}

async function writeJourney() {
  const writeStart = await events.store.head();
  await send('STAGE_B_WRITE: change the synthetic demo quote delivery slot to afternoon ' +
    'with the reviewed change_delivery_slot tool.');
  await waitForTurn(writeStart, true);
  const card = page.getByRole('region', { name: 'Approval needed', exact: true });
  await card.waitFor();
  const waiting = await readback('waiting');
  assert.equal(waiting.value.effectCount, 0);
  assert.equal(waiting.value.slot, 'morning');
  await captureWaitingApproval(page, output, 'write-waiting');
  await page.reload();
  await card.waitFor();
  await captureWaitingApproval(page, output, 'write-waiting-reloaded');
  record('waitingApproval', 'PASS');
  const approveButton = card.getByRole('button', { name: /^Approve:/u });
  await approveButton.click();
  record('requesterClickedApprove', true);
  const writeEnd = await waitForTurn(writeStart);
  await capture('write-approved');
  await readback('after');
  assert.equal(writeEnd?.event.type, 'agent.turn_completed', 'Approved write turn must complete');
  await page.reload();
  const usedApproval = page.getByRole('button', { name: /Approved by you.*used once/u });
  await usedApproval.waitFor();
  await capture('write-approved-reloaded');
  const reply = 'Quote DEMO-001: 12500 euro cents, afternoon delivery. Recorded effects: 1.';
  const replyText = page.getByText(reply, { exact: true });
  await replyText.waitFor();
  record('approvedReply', 'PASS');
  return writeEnd;
}

async function finalViews() {
  await collect();
  if (results.policy) await readback('finalReadback');
  await page.goto(origin + '/org/spending');
  const spendingLoaded = page.getByText('Spending loaded', { exact: true });
  await spendingLoaded.waitFor();
  await capture('spending');
  await get('spending', '/api/org/models');
  await page.goto(origin + '/org/history');
  const historyLoaded = page.getByText('History loaded', { exact: true });
  await historyLoaded.waitFor();
  await capture('change-history');
  await get('changeHistory', '/api/org/history');
  if (conversationId) {
    await get('actionHistory', `/api/conversations/${conversationId}/history`);
    await page.goto(`${origin}/history/${conversationId}`);
    await historyLoaded.waitFor();
    await capture('action-history');
  }
}

function failed(error) {
  record('failedSteps', [...results.failedSteps, String(error)]);
  record('status', 'PARTIAL');
  process.exitCode = 1;
  console.error('FAIL live collection: ' + String(error));
}

try {
  await get('personal', '/api/chat');
  record('grants', saved.grants);
  const policy = await readPolicy();
  record('policyAvailable', isToolPolicyAvailable(policy));
  assert(results.policyAvailable, 'Published policy must be available to chat');
  await readback('before');
  await get('spendingBefore', '/api/org/models');
  start = await events.store.head();
  record('start', start);
  await readJourney();
  const writeEnd = await writeJourney();
  await readPolicy();
  await collect();
  checkCosts();
  checkApproval(writeEnd);
  record('write', 'PASS');
  await finalViews();
  record('status', 'PASS');
} catch (error) {
  failed(error);
} finally {
  try {
    await events.close();
  } finally {
    await browser.close();
  }
  console.log(results.status + ' original live records and captures saved');
}
