import { jetstreamManager, type JetStreamManager } from '@nats-io/jetstream';
import { expect, it, vi, type TestContext } from 'vitest';
import { createEventStore, type AppendResult, type EventStore } from '../src/index.ts';
import { clusterFixture, waitForClusterStream, type Peer } from './cluster-fixture.ts';
import { checkQuorumLoss, checkSurvival, type Receipt } from './failover-check.ts';
import { event, lostReplyStore } from './testing.ts';

type Cluster = Awaited<ReturnType<typeof clusterFixture>>;
type FixtureEvent = ReturnType<typeof event>;

function acknowledgedReceipt(input: FixtureEvent, result: AppendResult): Receipt {
  if (result.status !== 'appended') {
    throw new Error('Expected an acknowledged fixture event');
  }
  return { id: input.id, commandId: input.commandId, subject: input.subject,
    sequence: result.sequence };
}

async function retainedHistory(store: EventStore) {
  const receipts: Receipt[] = [];
  const last = await store.head();
  for (let sequence = 1; sequence <= last; sequence++) {
    const row = await store.readEvent(sequence);
    if (!row.event.commandId) {
      throw new Error('Fixture event has no command identity');
    }
    receipts.push({ id: row.event.id, commandId: row.event.commandId,
      subject: row.event.subject, sequence: row.sequence });
  }
  return receipts;
}

function subjectPositions(receipts: Receipt[]) {
  const positions: Record<string, number> = {};
  for (const receipt of receipts) {
    positions[receipt.subject] = receipt.sequence;
  }
  return positions;
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
  await vi.waitFor(ready, { timeout: 10_000 });
}

async function localCopy(peer: Peer, messages: number) {
  async function caughtUp() {
    const response = await fetch(
      `http://127.0.0.1:${peer.monitor}/jsz?accounts=true&streams=true`,
      { signal: AbortSignal.timeout(1000) });
    expect(response.status).toBe(200);
    const info: unknown = await response.json();
    const state = { messages, first_seq: 1, last_seq: messages };
    const expectedState: unknown = expect.objectContaining(state);
    const stream: unknown = expect.objectContaining({ name: 'EVENTS', state: expectedState });
    const streams: unknown = expect.arrayContaining([stream]);
    const account: unknown = expect.objectContaining({ stream_detail: streams });
    const accounts: unknown = expect.arrayContaining([account]);
    expect(info).toMatchObject({ account_details: accounts });
  }
  await vi.waitFor(caughtUp, { timeout: 10_000 });
}

async function ownedLossPeers(cluster: Cluster, manager: JetStreamManager) {
  const info = await manager.streams.info('EVENTS');
  function isLeader(peer: Peer) {
    return peer.name === info.cluster?.leader;
  }
  const leader = cluster.peers.find(isLeader);
  if (!leader) {
    throw new Error('Stream leader is not an owned peer');
  }
  const others: Peer[] = [];
  for (const peer of cluster.peers) {
    if (peer !== leader) {
      others.push(peer);
    }
  }
  if (others.length !== 2) {
    throw new Error('Expected exactly three owned peers');
  }
  return { leader, second: others[0]!, survivor: others[1]! };
}

async function seedAcknowledgements(store: EventStore) {
  const first = event('before-quorum-loss');
  const firstCommand = { event: first, expectedSequence: 0 };
  const firstResult = await store.append(firstCommand);
  const second = event('other-before-quorum-loss', 'member-bob');
  const secondCommand = { event: second, expectedSequence: 0 };
  const secondResult = await store.append(secondCommand);
  return [acknowledgedReceipt(first, firstResult), acknowledgedReceipt(second, secondResult)];
}

async function reconcile(store: EventStore, input: FixtureEvent, observed: Receipt[]) {
  const command = { event: input, expectedSequence: 0 };
  const result = await store.append(command);
  const receipt = acknowledgedReceipt(input, result);
  for (const previous of observed) {
    if (previous.id === input.id) {
      expect(receipt).toEqual(previous);
    }
  }
  const expectedRow = { sequence: receipt.sequence, event: input };
  expect(await store.readEvent(receipt.sequence)).toEqual(expectedRow);
  const beforeRepeat = await retainedHistory(store);
  expect(await store.append(command)).toEqual(result);
  const repeated = { ...input, id: `${input.id}-repeat` };
  const repeatedCommand = { ...command, event: repeated };
  expect(await store.append(repeatedCommand)).toEqual(result);
  expect(await retainedHistory(store)).toEqual(beforeRepeat);
  return receipt;
}

async function checkReturnedPeers(cluster: Cluster, returned: Peer[], expected: Receipt[],
  positions: Record<string, number>) {
  for (const peer of returned) {
    // Check the peer's own stored copy; a client read alone can be forwarded elsewhere.
    await localCopy(peer, expected.length);
    const connection = await cluster.client(peer);
    const store = await createEventStore(connection);
    expect(await retainedHistory(store)).toEqual(expected);
    for (const [subject, position] of Object.entries(positions)) {
      expect(await store.head(subject)).toBe(position);
    }
  }
}

async function prepareDrill(cluster: Cluster) {
  const initialConnection = await cluster.client(cluster.peers[0]!);
  const initialStore = await createEventStore(initialConnection);
  await waitForClusterStream(initialStore);
  const initialManager = await jetstreamManager(initialConnection, { timeout: 250 });
  await currentCopies(initialManager);
  const { leader, second, survivor } = await ownedLossPeers(cluster, initialManager);
  const unowned = { ...leader };
  await expect(cluster.stop(unowned)).rejects.toThrow('Cannot stop an unowned peer');
  await expect(cluster.restart(unowned))
    .rejects.toThrow('Cannot restart a running or unowned peer');
  const connection = await cluster.client(survivor);
  const store = await createEventStore(connection);
  const manager = await jetstreamManager(connection, { timeout: 250 });
  const lost = await lostReplyStore(connection);
  return { leader, second, survivor, connection, store, manager, lost };
}

async function runQuorumLoss(cluster: Cluster, context: TestContext) {
  const drill = await prepareDrill(cluster);
  const { leader, second, survivor, connection, store, manager, lost } = drill;
  const acknowledged = await seedAcknowledgements(store);
  const baseline = await retainedHistory(store);
  const positionsBeforeLoss = subjectPositions(baseline);
  checkSurvival(baseline, acknowledged, positionsBeforeLoss, []);

  const racing = event('racing-quorum-loss', 'member-racing');
  const cancellation = new AbortController();
  const racingCommand = { event: racing, expectedSequence: 0, historyChecked: true as const,
    deadline: performance.now() + 1000, signal: cancellation.signal };
  lost.loseNextReply();
  const pending = lost.store.append(racingCommand);
  const stoppingLeader = cluster.stop(leader);
  // Stop retries after publication starts, keeping a lost reply uncertain through the loss.
  cancellation.abort();
  await stoppingLeader;
  await cluster.stop(second);
  const racingOutcome = await pending;
  checkQuorumLoss(racingOutcome.status, 'unresolved');
  expect(racingOutcome.outcome).toMatchObject({ possiblyPublished: true });
  const unresolved = [racing.id];

  // Keep this connection on the sole live peer throughout the unavailable write.
  expect(connection.getServer()).toContain(`:${survivor.port}`);
  const minority = event('without-quorum', 'member-minority');
  const started = performance.now();
  const minorityCommand = { event: minority, expectedSequence: 0, historyChecked: true as const,
    deadline: started + 750 };
  const minorityOutcome = await store.append(minorityCommand);
  expect(performance.now() - started).toBeLessThan(2000);
  checkQuorumLoss(minorityOutcome.status, 'unresolved');
  expect(minorityOutcome.outcome).toMatchObject({ possiblyPublished: true });
  unresolved.push(minority.id);
  expect(connection.isClosed()).toBe(false);
  await expect(currentCopies(manager)).rejects.toThrow();

  await cluster.restart(leader);
  await cluster.restart(second);
  await cluster.ready();
  await currentCopies(manager);
  const afterReturn = await retainedHistory(store);
  expect(afterReturn.slice(0, baseline.length)).toEqual(baseline);
  for (const [subject, position] of Object.entries(positionsBeforeLoss)) {
    expect(await store.head(subject)).toBe(position);
  }
  const beforeResolution = checkSurvival(afterReturn, acknowledged,
    subjectPositions(afterReturn), unresolved);
  expect(beforeResolution.unresolved).toEqual(unresolved);
  for (const row of afterReturn.slice(baseline.length)) {
    expect(unresolved).toContain(row.id);
  }

  acknowledged.push(await reconcile(store, racing, afterReturn));
  acknowledged.push(await reconcile(store, minority, afterReturn));
  const stale = { event: event('stale-after-return'), expectedSequence: 0 };
  expect(await store.append(stale)).toEqual({ status: 'conflict' });

  const recovered = event('lost-ack-after-return', 'member-recovered');
  lost.loseNextReply();
  const recoveredCommand = { event: recovered, expectedSequence: 0 };
  const recoveredResult = await lost.store.append(recoveredCommand);
  expect(recoveredResult.outcome?.kind).toBe('duplicate_saved');
  acknowledged.push(acknowledgedReceipt(recovered, recoveredResult));
  await reconcile(store, recovered, acknowledged);
  const finalHistory = await retainedHistory(store);
  expect(finalHistory).toHaveLength(5);
  const finalPositions = subjectPositions(finalHistory);
  const finalCheck = checkSurvival(finalHistory, acknowledged, finalPositions, []);
  await currentCopies(manager);
  await checkReturnedPeers(cluster, [leader, second], finalHistory, finalPositions);
  const evidence = { stoppedPeers: [leader.name, second.name],
    minorityOutcome: minorityOutcome.status, racingOutcome: racingOutcome.status,
    beforeResolution, receipts: finalHistory, positions: finalPositions, ...finalCheck };
  await context.annotate(JSON.stringify(evidence));
}

async function refusesWritesAndRecovers(context: TestContext) {
  const cluster = await clusterFixture();
  let failure: { cause: unknown } | undefined;
  try {
    await runQuorumLoss(cluster, context);
  } catch (cause) {
    failure = { cause };
  }
  try {
    await cluster.close();
  } catch {
    if (!failure) {
      throw new Error('Owned fixture cleanup failed');
    }
    await context.annotate('Owned fixture cleanup: FAIL');
  }
  // Preserve the original failure if cleanup also fails.
  if (failure) {
    throw failure.cause;
  }
}
it('refuses writes without quorum and recovers the same event history',
  refusesWritesAndRecovers, 60_000);
