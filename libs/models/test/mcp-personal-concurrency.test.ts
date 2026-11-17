import type { AppendCommand } from '@opencrane/event-store';
import { grantStream, memberAuthorisation } from '@opencrane/authz';
import { expect, it, onTestFinished, vi } from 'vitest';
import { z } from 'zod';
import { history } from '../src/actor.ts';
import { body, permit, send, publishedFixture, selectedPersonalFixture, requestFromPermit }
  from './support/mcp-dispatch-fixture.ts';
import { personalPair } from './support/personal-dispatch.ts';
import { delayReceiptReplies } from './support/dispatch-receipts.ts';

async function distinctPersonalTurns() {
  const context = await selectedPersonalFixture();
  const pair = await personalPair(context, body);
  // Distinguish calls by business data because private thread metadata never leaves the server.
  pair.bob.body = pair.bob.body.replace('SO-1042', 'SO-BOB');
  expect(pair.bob.body).toContain('SO-BOB');
  return pair;
}

async function concurrentPersonalTurns() {
  const { setup, remote, headers, bob, reads } = await distinctPersonalTurns();
  const alicePermit = await permit(setup, headers);
  const bobPermit = await permit(setup, bob.headers, bob.body);
  const append = setup.nats.store.append.bind(setup.nats.store);
  const bothReady = Promise.withResolvers<void>();
  let attempts = 0;
  async function overlapAdmissions(command: AppendCommand) {
    const event = z.object({ type: z.string() }).parse(command.event);
    if (event.type === 'mcp.dispatch_admitted') {
      attempts += 1;
      if (attempts === 2) bothReady.resolve();
      await bothReady.promise;
    }
    return append(command);
  }
  const delayed = vi.spyOn(setup.nats.store, 'append');
  delayed.mockImplementation(overlapAdmissions);
  try {
    const responses = await Promise.all([
      send(setup, alicePermit), send(setup, bobPermit, bob.body),
    ]);
    for (const response of responses) expect(response.status, await response.text()).toBe(200);
    expect(reads.toSorted()).toEqual(['alice', 'bob']);
    expect(remote.received).toHaveLength(2);
    for (const received of remote.received) {
      const raw = received.raw.toString();
      const expected = raw === bob.body ? 'Bearer bob-access' : 'Bearer alice-access';
      expect(received.headers.authorization).toBe(expected);
    }
    for (const [value, userId, assistantId] of [
      [alicePermit, 'alice', 'assistant'], [bobPermit, 'bob', 'bob-assistant'],
    ]) {
      const requestId = requestFromPermit(value!);
      const rows = await history(setup.nats.store, `credential-${requestId}`, 'test');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.event.data).toMatchObject({ userId, ownerId: userId, assistantId });
    }
    expect((await send(setup, alicePermit)).status).toBe(403);
    expect((await send(setup, bobPermit, bob.body)).status).toBe(403);
    expect(remote.received).toHaveLength(2);
  } finally {
    bothReady.resolve();
    delayed.mockRestore();
  }
}
it('races two personal assistants on one server without mixing credentials',
  concurrentPersonalTurns, 60_000);

async function noKeyReceiptWork() {
  const context = await publishedFixture();
  const { setup } = context;
  const headers = { ...context.headers, ...context.constants };
  const value = await permit(setup, headers);
  delayReceiptReplies(setup);
  const started = performance.now();
  const response = await send(setup, value);
  const elapsedMs = Math.ceil(performance.now() - started);
  expect(response.status, `Dispatch completed in ${elapsedMs} ms`).toBe(200);
  expect(setup.received()).toBe(1);
}
it('prepares immutable receipt work for a tool that needs no personal key',
  noKeyReceiptWork, 60_000);

async function concurrentReceiptWork() {
  const { setup, remote, headers, bob } = await distinctPersonalTurns();
  const alicePermit = await permit(setup, headers);
  const bobPermit = await permit(setup, bob.headers, bob.body);
  delayReceiptReplies(setup);
  const responses = await Promise.all([
    send(setup, alicePermit), send(setup, bobPermit, bob.body),
  ]);
  for (const response of responses) {
    expect(response.status, await response.text()).toBe(200);
  }
  expect(remote.received).toHaveLength(2);
  for (const received of remote.received) {
    const expected = received.raw.toString() === bob.body ? 'Bearer bob-access' : 'Bearer alice-access';
    expect(received.headers.authorization).toBe(expected);
  }
}
it('keeps concurrent credential releases within the access window with receipt service work',
  concurrentReceiptWork, 60_000);

async function permissionChangedWhileQueued() {
  const context = await selectedPersonalFixture();
  const { setup, remote, headers, bob } = await personalPair(context, body);
  const alicePermit = await permit(setup, headers);
  const bobPermit = await permit(setup, bob.headers, bob.body);
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const queued = Promise.withResolvers<void>();
  const append = setup.nats.store.append.bind(setup.nats.store);
  async function holdFirstAdmission(command: AppendCommand) {
    const parsed = z.object({ type: z.string() }).parse(command.event);
    if (parsed.type === 'budget.call_dispatch_admitted') {
      entered.resolve();
      await released.promise;
    }
    return append(command);
  }
  const admit = setup.actor.admitDispatch.bind(setup.actor);
  let admissions = 0;
  function observeAdmission(...args: Parameters<typeof admit>) {
    admissions += 1;
    const result = admit(...args);
    if (admissions === 2) queued.resolve();
    return result;
  }
  const writer = vi.spyOn(setup.nats.store, 'append');
  writer.mockImplementation(holdFirstAdmission);
  const admission = vi.spyOn(setup.actor, 'admitDispatch');
  admission.mockImplementation(observeAdmission);
  function restoreChecks() {
    vi.restoreAllMocks();
  }
  onTestFinished(restoreChecks);
  const alice = send(setup, alicePermit);
  try {
    await entered.promise;
    const bobResponse = send(setup, bobPermit, bob.body);
    await queued.promise;
    await setup.append(grantStream('mcp_server', 'fixture'), 'grant.revoked', {
      resourceType: 'mcp_server', resourceId: 'fixture',
      granteeKind: 'member', granteeId: 'bob', revokedBy: 'alice',
    });
    released.resolve();
    expect((await bobResponse).status).toBe(403);
    expect((await alice).status).toBe(200);
    expect(remote.received).toHaveLength(1);
    expect(remote.received[0]!.headers.authorization).toBe('Bearer alice-access');
  } finally {
    released.resolve();
    await alice;
  }
}
it('refuses a permission removed while the personal dispatch waits in the budget queue',
  permissionChangedWhileQueued, 60_000);

async function receiptUnavailableOnNextRequest() {
  const context = await selectedPersonalFixture();
  const { setup, remote, headers } = await personalPair(context, body);
  const first = await permit(setup, headers);
  const second = await permit(setup, headers);
  expect((await send(setup, first)).status).toBe(200);
  const auth = memberAuthorisation(setup.binding);
  function restoreChecks() {
    vi.restoreAllMocks();
  }
  onTestFinished(restoreChecks);
  const missingReceipt = { allowed: false, status: 'ok' as const };
  const appliedCheck = vi.spyOn(auth, 'checkApplied');
  appliedCheck.mockResolvedValue(missingReceipt);
  expect((await send(setup, second)).status).toBe(403);
  expect(remote.received).toHaveLength(1);
}
it('does not reuse an earlier request’s receipt when the next request cannot confirm it',
  receiptUnavailableOnNextRequest, 60_000);

async function foreignPersonalLease() {
  const context = await selectedPersonalFixture();
  const { setup, remote, headers, bob, reads } = await personalPair(context, body);
  const alicePermit = await permit(setup, headers);
  expect((await send(setup, alicePermit, bob.body)).status).toBe(403);
  expect((await send(setup, alicePermit)).status).toBe(403);
  expect(reads).toEqual([]);
  expect(remote.received).toHaveLength(0);
}
it('burns a personal lease used with another person’s request', foreignPersonalLease, 60_000);

async function revokedDuringMaterialRead() {
  const context = await selectedPersonalFixture();
  const { setup, remote, headers, bob, saved } = await personalPair(context, body);
  const alicePermit = await permit(setup, headers);
  const bobPermit = await permit(setup, bob.headers, bob.body);
  const custody = setup.dispatchOptions.credentialDispatch!.custody;
  const read = custody.readAccessMaterial;
  const readAccessMaterial: typeof read = async function readAccessMaterial(stage, identity, format) {
    if (stage.userId === 'alice') {
      await setup.append(saved.subject, 'connection.revoked', {
        userId: 'alice', serverId: 'fixture', profile: 'alice-profile',
        revokedBy: 'alice', expectedSequence: saved.revision, reason: 'owner_requested',
      });
    }
    return read(stage, identity, format);
  };
  custody.readAccessMaterial = readAccessMaterial;
  expect((await send(setup, alicePermit)).status).toBe(403);
  expect((await send(setup, bobPermit, bob.body)).status).toBe(200);
  expect(remote.received).toHaveLength(1);
  expect(remote.received[0]!.headers.authorization).toBe('Bearer bob-access');
}
it('refuses a key revoked during release while the other person can still call',
  revokedDuringMaterialRead, 60_000);

async function unavailablePermissionDuringRelease() {
  const context = await selectedPersonalFixture();
  const { setup, remote, headers } = await personalPair(context, body);
  const value = await permit(setup, headers);
  const auth = memberAuthorisation(setup.binding);
  const use = auth.use.bind(auth);
  let unavailable = false;
  const custody = setup.dispatchOptions.credentialDispatch!.custody;
  const read = custody.readAccessMaterial;
  const readAccessMaterial: typeof read = async function readAccessMaterial(stage, identity, format) {
    const material = await read(stage, identity, format);
    unavailable = true;
    return material;
  };
  const checkUse: typeof auth.use = async function checkUse(...args) {
    if (unavailable) return { allowed: false, status: 'unavailable',
      error: new Error('Permission service unavailable') };
    return use(...args);
  };
  function restoreChecks() {
    vi.restoreAllMocks();
  }
  onTestFinished(restoreChecks);
  custody.readAccessMaterial = readAccessMaterial;
  const permissionCheck = vi.spyOn(auth, 'use');
  permissionCheck.mockImplementation(checkUse);
  expect((await send(setup, value)).status).toBe(403);
  expect(remote.received).toHaveLength(0);
}
it('rechecks live permission availability after reading personal key material',
  unavailablePermissionDuringRelease, 60_000);

async function anotherAccountArgument() {
  const context = await selectedPersonalFixture();
  const { setup, remote, headers } = await personalPair(context, body);
  const raw = body.replace('"arguments":{',
    '"arguments":{"account":"bob","userId":"bob","profileId":"bob-profile",');
  const value = await permit(setup, headers, raw);
  expect((await send(setup, value, raw)).status).toBe(200);
  expect(remote.received).toHaveLength(1);
  expect(remote.received[0]!.headers.authorization).toBe('Bearer alice-access');
}
it('cannot select Bob’s existing key through Alice’s tool arguments',
  anotherAccountArgument, 60_000);

async function noPersonalFallback() {
  const context = await selectedPersonalFixture();
  const { setup, remote, headers, bob } = await personalPair(context, body);
  const subject = 'connection-selection-bob-fixture';
  const expectedSequence = await setup.nats.store.head(subject);
  await setup.append(subject, 'connection.selected', {
    action: 'clear', userId: 'bob', serverId: 'fixture', connectionId: 'installed',
    expectedSequence,
  });
  const raw = bob.body.replace('"arguments":{',
    '"arguments":{"account":"alice","profileId":"alice-profile",');
  const response = await fetch(`${setup.options.decisionUrl}/authorize/mcp/fixture/installed`,
    { method: 'POST', headers: bob.headers, body: raw });
  expect(response.status).toBe(403);
  expect(remote.received).toHaveLength(0);
  const value = await permit(setup, headers);
  expect((await send(setup, value)).status).toBe(200);
  expect(remote.received).toHaveLength(1);
  expect(remote.received[0]!.headers.authorization).toBe('Bearer alice-access');
}
it('refuses a missing selection instead of falling back to another saved account',
  noPersonalFallback, 60_000);
