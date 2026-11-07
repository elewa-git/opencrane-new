import { afterEach, expect, it } from 'vitest';
import { natsFixture, event } from '@opencrane/event-store/testing';
import { readComputerControl } from '@opencrane/auth';
import { grantWriter, renewWriter, returnWriter, WriterSlot } from '../src/computers/writer-lease.ts';
import { writerStream } from '../src/computers/rfb.ts';

let fixture: Awaited<ReturnType<typeof natsFixture>>;
afterEach(async function closeFixture() { await fixture?.close(); });

const binding = { assistantId: 'assistant', computerId: 'desktop', generation: 1,
  podUid: 'pod', conversationId: 'chat', requesterId: 'alice',
  requesterEventId: 'request', takeoverId: 'takeover', leaseId: 'lease',
  affectedTurnIds: [] };

async function setup() {
  fixture = await natsFixture();
  const requested = event('requested', 'computer-assistant', 'takeover.requested');
  requested.commandId = 'request-command';
  requested.data = { ...binding, reason: 'requester_requested' };
  const pausing = event('pausing', 'computer-assistant', 'takeover.pausing');
  pausing.data = { ...binding, bridgeEpoch: 'bridge', supervisorEpoch: 'supervisor',
    executionProof: 'exited', quietProof: 'unavailable' };
  const paused = event('paused', 'computer-assistant', 'takeover.paused');
  paused.data = { ...binding, bridgeEpoch: 'bridge', supervisorEpoch: 'supervisor',
    quietProof: 'complete' };
  await fixture.seed([requested, pausing, paused]);
  const input = { ...binding, commandId: 'start-command', writerSessionId: 'socket',
    proxyInstanceId: 'proxy', expiresAt: new Date(Date.now() + 60_000).toISOString() };
  return { store: fixture.store, input };
}

async function grantsOnlyAfterQuietProof() {
  const { store, input } = await setup();
  const started = await grantWriter(store, 'test', input);
  expect(started.phase).toBe('started');
  expect((await readComputerControl(store, 'test', 'assistant'))?.phase).toBe('started');
  await expect(grantWriter(store, 'test', { ...input, commandId: 'second' }))
    .rejects.toThrow();
}
it('saves one exclusive writer lease after quiet proof', grantsOnlyAfterQuietProof);

async function returnsOnceAndCannotRenew() {
  const { store, input } = await setup();
  await grantWriter(store, 'test', input);
  const returned = await returnWriter(store, 'test', { ...binding, commandId: 'return-command',
    writerSessionId: input.writerSessionId });
  expect(returned.phase).toBe('returning');
  expect(await returnWriter(store, 'test', { ...binding, commandId: 'return-command',
    writerSessionId: input.writerSessionId })).toEqual(returned);
  await expect(renewWriter(store, 'test', { ...binding, commandId: 'renew-command',
    writerSessionId: input.writerSessionId,
    expiresAt: new Date(Date.now() + 60_000).toISOString() })).rejects.toThrow();
}
it('saves Return once and refuses renewal afterwards', returnsOnceAndCannotRenew);

function refusesInputOutsideTheSingleSlot() {
  const forwarded: Buffer[] = [];
  const slot = new WriterSlot();
  expect(slot.claim('lease', 'socket')).toBe(true);
  expect(slot.claim('lease', 'second')).toBe(false);
  const accepted = writerStream(slot, 'lease', 'socket', bytes => forwarded.push(bytes));
  accepted(Buffer.from('RFB 003.008\n'));
  accepted(Buffer.from([1]));
  accepted(Buffer.from([1]));
  accepted(Buffer.from([4, 1, 0, 0, 0, 0, 0, 65]));
  expect(forwarded).toHaveLength(4);
  accepted(Buffer.from([6, 0, 0, 0]));
  expect(forwarded).toHaveLength(4);
  slot.close();
  accepted(Buffer.from([4, 1, 0, 0, 0, 0, 0, 65]));
  expect(forwarded).toHaveLength(4);
}
it('refuses clipboard and input after the writer slot closes', refusesInputOutsideTheSingleSlot);
