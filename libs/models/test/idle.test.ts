import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { natsFixture } from '@opencrane/event-store/testing';
import { expect, it, vi } from 'vitest';
import { BudgetActor, history, ingestUsage, priceTableId } from '../src/index.ts';

async function budgetFixture() {
  const nats = await natsFixture();
  const directory = await mkdtemp(`${tmpdir()}/budget-idle-`);
  let now = new Date('2026-10-05T12:00:00Z');
  function clock() {
    return now;
  }
  const actor = new BudgetActor(nats.store, 'test', clock);
  await actor.start(20_000, 20_000, 'group');
  async function reserve() {
    const call = {
      model: 'gpt-6-astra', priceTableId, computerId: 'computer', assistantId: 'assistant',
      requesterId: 'alice', conversationId: 'conversation', turnId: 'turn', threadId: 'thread',
      payingGroupId: 'group', contextDigest: '0'.repeat(64),
    };
    return actor.reserve(call, 1000);
  }
  async function close() {
    vi.restoreAllMocks();
    await nats.close();
    await rm(directory, { recursive: true, force: true });
  }
  function advance() {
    now = new Date(now.getTime() + 181_000);
  }
  return { nats, actor, directory, reserve, close, advance, clock };
}
function usageLine(id: string) {
  const usage = {
    id, inputTokens: 100, outputTokens: 10, cachedInputTokens: 50, cacheWriteTokens: 25,
  };
  return `${JSON.stringify(usage)}\n`;
}

async function readsNewUsage() {
  const fixture = await budgetFixture();
  const file = `${fixture.directory}/usage.jsonl`;
  const first = await fixture.reserve();
  const second = await fixture.reserve();
  const cursor = { offset: 0 };
  const reads = vi.spyOn(fixture.nats.store, 'readStream');
  try {
    const oldUsage = usageLine(first).repeat(100);
    await writeFile(file, oldUsage);
    await ingestUsage(fixture.actor, file, cursor);
    reads.mockClear();
    await ingestUsage(fixture.actor, file, cursor);
    await fixture.actor.expire();
    expect(reads).not.toHaveBeenCalled();
    await appendFile(file, usageLine(second));
    await ingestUsage(fixture.actor, file, cursor);
    expect(await history(fixture.nats.store, `effect-${second}`, 'test')).toMatchObject([
      { event: { type: 'effect.observed' } },
    ]);
  } finally {
    await fixture.close();
  }
}

it('leaves old usage unread on an idle tick and picks up the next usage line', readsNewUsage);

async function recordsTimeoutOnce() {
  const fixture = await budgetFixture();
  const id = await fixture.reserve();
  fixture.advance();
  const reads = vi.spyOn(fixture.nats.store, 'readStream');
  try {
    await fixture.actor.expire();
    reads.mockClear();
    await fixture.actor.expire();
    expect(reads).not.toHaveBeenCalled();
    const restarted = new BudgetActor(fixture.nats.store, 'test', fixture.clock);
    await restarted.start();
    await restarted.expire();
    reads.mockClear();
    await restarted.expire();
    expect(reads).not.toHaveBeenCalled();
    const rows = await history(fixture.nats.store, `effect-${id}`, 'test');
    expect(rows).toMatchObject([{ event: { type: 'effect.uncertain' } }]);
    await restarted.effect(id, { inputTokens: 100, outputTokens: 10 });
    const lateRows = await history(fixture.nats.store, `effect-${id}`, 'test');
    expect(lateRows.at(-1)?.event.type).toBe('effect.observed');
  } finally {
    await fixture.close();
  }
}

it('records an old reservation timeout once, including after restarting the actor', recordsTimeoutOnce);

async function readsTruncatedFile() {
  const fixture = await budgetFixture();
  const file = `${fixture.directory}/usage.jsonl`;
  const first = await fixture.reserve();
  const second = await fixture.reserve();
  const cursor = { offset: 0 };
  try {
    await writeFile(file, usageLine(first) + usageLine(first));
    await ingestUsage(fixture.actor, file, cursor);
    await writeFile(file, usageLine(second));
    await ingestUsage(fixture.actor, file, cursor);
    const rows = await history(fixture.nats.store, `effect-${second}`, 'test');
    expect(rows).toMatchObject([{ event: { type: 'effect.observed' } }]);
  } finally {
    await fixture.close();
  }
}

it('reads usage from the start after the file becomes smaller', readsTruncatedFile);

async function retriesCompleteUsage() {
  const fixture = await budgetFixture();
  const file = `${fixture.directory}/usage.jsonl`;
  const id = await fixture.reserve();
  const line = usageLine(id);
  const cursor = { offset: 0 };
  const reads = vi.spyOn(fixture.nats.store, 'readStream');
  try {
    await writeFile(file, line.slice(0, -1));
    await ingestUsage(fixture.actor, file, cursor);
    expect(reads).not.toHaveBeenCalled();
    await appendFile(file, '\n');
    const appends = vi.spyOn(fixture.nats.store, 'append');
    appends.mockRejectedValueOnce(new Error('Temporary event-store failure'));
    await expect(ingestUsage(fixture.actor, file, cursor)).rejects.toThrow('Temporary');
    await ingestUsage(fixture.actor, file, cursor);
    reads.mockClear();
    await ingestUsage(fixture.actor, file, cursor);
    expect(reads).not.toHaveBeenCalled();
    const rows = await history(fixture.nats.store, `effect-${id}`, 'test');
    expect(rows).toMatchObject([{ event: { type: 'effect.observed' } }]);
  } finally {
    await fixture.close();
  }
}

it('waits for a complete usage line and retries it after a failed append', retriesCompleteUsage);

async function retriesFailedTimeoutAppend() {
  const fixture = await budgetFixture();
  try {
    const id = await fixture.reserve();
    fixture.advance();
    const appends = vi.spyOn(fixture.nats.store, 'append');
    const unavailable = { status: 'unavailable' as const, cause: new Error('Temporary NATS outage') };
    appends.mockResolvedValueOnce(unavailable);
    await expect(fixture.actor.expire()).rejects.toThrow('Effect append failed');
    await fixture.actor.expire();
    const rows = await history(fixture.nats.store, `effect-${id}`, 'test');
    expect(rows).toMatchObject([{ event: { type: 'effect.uncertain' } }]);
  } finally {
    await fixture.close();
  }
}

it('retries a reservation timeout when its event append failed', retriesFailedTimeoutAppend);
