import { jetstreamManager, type JetStreamManager } from '@nats-io/jetstream';
import { expect, it, onTestFinished, vi, type TestContext } from 'vitest';
import { createEventStore, type AppendResult, type EventStore } from '../src/index.ts';
import { clusterFixture, waitForClusterStream, type Peer } from './cluster-fixture.ts';
import { checkSurvival, type Receipt } from './failover-check.ts';
import { event, lostReplyStore } from './testing.ts';

function receipt(input: ReturnType<typeof event>, result: AppendResult): Receipt {
  expect(result.status).toBe('appended');
  if (result.status !== 'appended') {
    throw new Error('Expected an acknowledged append');
  }
  return { id: input.id, commandId: input.commandId, subject: input.subject,
    sequence: result.sequence };
}

async function history(store: EventStore) {
  const retained: Receipt[] = [];
  const last = await store.head();
  for (let sequence = 1; sequence <= last; sequence++) {
    const row = await store.readEvent(sequence);
    expect(row.event.commandId).toBeDefined();
    retained.push({ id: row.event.id, commandId: row.event.commandId!,
      subject: row.event.subject, sequence: row.sequence });
  }
  return retained;
}

async function currentCopies(manager: JetStreamManager) {
  async function ready() {
    const info = await manager.streams.info('EVENTS');
    expect(info.config.num_replicas).toBe(3);
    expect(info.cluster?.replicas).toHaveLength(2);
    for (const replica of info.cluster!.replicas!) {
      expect(replica.current).toBe(true);
      expect(replica.offline).not.toBe(true);
    }
  }
  await vi.waitFor(ready, { timeout: 5000 });
}

async function survivingQuorum(manager: JetStreamManager, stopped: string) {
  async function ready() {
    const info = await manager.streams.info('EVENTS');
    expect(info.cluster?.leader).toMatch(/^peer-[123]$/);
    expect(info.cluster?.leader).not.toBe(stopped);
    let currentSurvivors = 1;
    for (const replica of info.cluster?.replicas ?? []) {
      if (replica.name !== stopped && replica.current && !replica.offline) {
        currentSurvivors++;
      }
    }
    expect(currentSurvivors).toBe(2);
  }
  await vi.waitFor(ready, { timeout: 10_000 });
}

async function returningReplicaState(peer: Peer, messages: number) {
  async function caughtUp() {
    const response = await fetch(
      `http://127.0.0.1:${peer.monitor}/jsz?accounts=true&streams=true`,
      { signal: AbortSignal.timeout(1000) });
    const info: unknown = await response.json();
    const state = { messages, first_seq: 1, last_seq: messages };
    const expectedState: unknown = expect.objectContaining(state);
    const stream: unknown = expect.objectContaining({ name: 'EVENTS', state: expectedState });
    const streams: unknown = expect.arrayContaining([stream]);
    const account: unknown = expect.objectContaining({ stream_detail: streams });
    const accounts: unknown = expect.arrayContaining([account]);
    expect(info).toMatchObject({ account_details: accounts });
  }
  await vi.waitFor(caughtUp, { timeout: 5000 });
}

async function prepareDrill() {
  const cluster = await clusterFixture();
  onTestFinished(cluster.close);
  const initialConnection = await cluster.client(cluster.peers[0]!);
  const initial = await createEventStore(initialConnection);
  await waitForClusterStream(initial);
  const manager = await jetstreamManager(initialConnection, { timeout: 250 });
  await currentCopies(manager);
  const info = await manager.streams.info('EVENTS');
  const leader = cluster.peers.find(isLeader);
  function isLeader(peer: (typeof cluster.peers)[number]) {
    return peer.name === info.cluster?.leader;
  }
  if (!leader) {
    throw new Error('Stream leader is not an owned peer');
  }
  const survivor = cluster.peers.find(isSurvivor)!;
  function isSurvivor(peer: (typeof cluster.peers)[number]) {
    return peer !== leader;
  }
  const connection = await cluster.client(survivor);
  const store = await createEventStore(connection);
  const survivingManager = await jetstreamManager(connection, { timeout: 250 });
  const lost = await lostReplyStore(connection);
  return { cluster, leader, store, survivingManager, lost };
}

async function survivesLeaderLoss(context: TestContext) {
  const { cluster, leader, store, survivingManager, lost } = await prepareDrill();
  const acknowledged: Receipt[] = [];
  const unresolved: string[] = [];
  const first = event('before-loss');
  const firstResult = await store.append({ event: first, expectedSequence: 0 });
  acknowledged.push(receipt(first, firstResult));
  const other = event('other-subject', 'member-bob');
  const otherResult = await store.append({ event: other, expectedSequence: 0 });
  acknowledged.push(receipt(other, otherResult));

  const racing = event('racing');
  const racingCommand = { event: racing, expectedSequence: 1, historyChecked: true as const };
  const pending = store.append(racingCommand);
  await cluster.stop(leader);
  await survivingQuorum(survivingManager, leader.name);
  const outcome = await pending;
  if (outcome.status === 'unavailable') {
    unresolved.push(racing.id);
  } else {
    acknowledged.push(receipt(racing, outcome));
  }
  const after = event('after-loss', 'member-bob');
  const afterResult = await store.append({ event: after, expectedSequence: 2 });
  acknowledged.push(receipt(after, afterResult));
  expect(await store.append({ event: event('stale'), expectedSequence: 0 }))
    .toEqual({ status: 'conflict' });

  const recovered = event('lost-reply', 'member-bob');
  const command = { event: recovered, expectedSequence: receipt(after, afterResult).sequence };
  lost.loseNextReply();
  const recoveredResult = await lost.store.append(command);
  const recoveredReceipt = receipt(recovered, recoveredResult);
  acknowledged.push(recoveredReceipt);
  expect(await store.readEvent(recoveredReceipt.sequence))
    .toEqual({ sequence: recoveredReceipt.sequence, event: recovered });
  const beforeRejoin = await history(store);
  const positions = { 'member-alice': await store.head('member-alice'),
    'member-bob': await store.head('member-bob') };
  const beforeCheck = checkSurvival(beforeRejoin, acknowledged, positions, unresolved);
  expect(beforeCheck.acknowledged).toBe(acknowledged.length);
  expect(beforeCheck.unresolved).toEqual(unresolved);

  await cluster.restart(leader);
  await cluster.ready();
  await currentCopies(survivingManager);
  const current = await survivingManager.streams.info('EVENTS');
  const returningReplica = { name: leader.name, current: true };
  const expectedReplica: unknown = expect.objectContaining(returningReplica);
  expect(current.cluster?.replicas).toContainEqual(expectedReplica);
  await returningReplicaState(leader, beforeRejoin.length);
  const returningConnection = await cluster.client(leader);
  const returning = await createEventStore(returningConnection);
  expect(await history(returning)).toEqual(beforeRejoin);
  for (const [subject, position] of Object.entries(positions)) {
    expect(await returning.head(subject)).toBe(position);
  }
  expect(await returning.append(command)).toEqual(recoveredResult);
  // Keep the same command identity across rejoin, even when supplying a different event id.
  const repeat = { ...recovered, id: 'repeat-event' };
  expect(await returning.append({ ...command, event: repeat })).toEqual(recoveredResult);
  expect(await history(store)).toEqual(beforeRejoin);
  expect(checkSurvival(await history(returning), acknowledged, positions, unresolved))
    .toEqual(beforeCheck);
  const evidence = { stoppedPeer: leader.name, receipts: acknowledged, positions,
    racingOutcome: outcome.status, ...beforeCheck };
  await context.annotate(JSON.stringify(evidence));
}
it('keeps acknowledged events through stream leader loss and the same peer rejoining',
  survivesLeaderLoss, 45_000);

async function preservesUncertainProvisioning() {
  const uncertain = new Error('Provisioning reply was lost');
  const ensureStream = vi.fn();
  ensureStream.mockRejectedValueOnce(uncertain);
  ensureStream.mockResolvedValue(undefined);
  await expect(waitForClusterStream({ ensureStream })).rejects.toBe(uncertain);
  expect(ensureStream).toHaveBeenCalledTimes(1);
}
it('does not repeat provisioning after an uncertain reply', preservesUncertainProvisioning);
