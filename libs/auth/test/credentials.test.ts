import { generateKeyPairSync } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { countReads, event, expectNoWholeReads, natsFixture } from '@opencrane/event-store/testing';
import { computerCredentials, tokenIssuer } from '../src/index.ts';

let nats: Awaited<ReturnType<typeof natsFixture>>;
async function close() {
  await nats?.close();
}
afterEach(close);
const input = { assistantId: 'assistant', conversationId: 'chat', turnId: 'turn',
  requesterId: 'alice', threadId: 'thread', task: 'chat_turn', model: 'gpt-6.1-sol' };

async function setup() {
  nats = await natsFixture();
  const options = { namedCurve: 'P-256',
    privateKeyEncoding: { type: 'pkcs8' as const, format: 'pem' as const },
    publicKeyEncoding: { type: 'spki' as const, format: 'pem' as const } };
  const key = generateKeyPairSync('ec', options);
  const privateKeyPath = `${dirname(nats.env().NATS_CA_FILE)}/key.pem`;
  await writeFile(privateKeyPath, key.privateKey, { mode: 0o600 });
  const tokens = await tokenIssuer({ privateKeyPath, issuer: 'https://test.invalid' });
  const computer = await tokens.computer({ silo: 'test', assistantId: 'assistant',
    computerId: 'computer', generation: 1 });
  const claimed = event('claim', 'computer-assistant', 'computer.claimed');
  const ready = event('ready', claimed.subject, 'computer.ready');
  const identity = { assistantId: 'assistant', computerId: 'computer', generation: 1 };
  await nats.seed([
    { ...claimed, data: { ...identity, tokenId: computer.id } },
    { ...ready, data: identity },
  ]);
  return { tokens, computer, credentials: computerCredentials(nats.store, tokens, 'test') };
}
async function readsOnlyTailForWarmCredentials() {
  const test = await setup();
  const rows = [];
  for (let index = 0; index < 500; index++) {
    const started = event(`start-${index}`, 'computer-assistant', 'computer.turn_started');
    const closed = event(`close-${index}`, started.subject, 'computer.turn_closed');
    const data = { assistantId: 'assistant', computerId: 'computer', conversationId: 'chat',
      turnId: `old-${index}`, threadId: 'thread', requesterId: 'alice', task: 'chat_turn' };
    rows.push({ ...started, data }, { ...closed, data: { ...data, status: 'completed' } });
  }
  await nats.seed(rows);
  await test.credentials.turn(input);
  const reads = countReads(nats.store);
  const turn = await test.credentials.turn(input);
  expectNoWholeReads(reads.calls);
  let rowsRead = 0;
  for (const call of reads.calls) rowsRead += call.rows;
  expect(rowsRead).toBeLessThanOrEqual(2);
  expect(await test.credentials.check({ authorization: `Bearer ${test.computer.value}`,
    'x-turn-token': turn.value, 'session-id': 'thread' })).toMatchObject({
    computer: { computer: 'computer', generation: 1 }, turn: { turn: 'turn' },
  });
}
it('issues and checks warm credentials without rereading 500 earlier turns',
  readsOnlyTailForWarmCredentials);

async function refusesSuspensionFromAnotherConnection() {
  const test = await setup();
  const turn = await test.credentials.turn(input);
  const headers = { authorization: `Bearer ${test.computer.value}`,
    'x-turn-token': turn.value, 'session-id': 'thread' };
  expect(await test.credentials.check(headers)).toMatchObject({ computer: { computer: 'computer' } });
  const { createEventStore } = await import('@opencrane/event-store');
  const other = await createEventStore(await nats.client('command'));
  const suspended = event('suspend', 'computer-assistant', 'computer.suspended');
  const command = { expectedSequence: await other.head(suspended.subject), historyChecked: true as const,
    event: { ...suspended, data: { assistantId: 'assistant', computerId: 'computer' } } };
  expect((await other.append(command)).status).toBe('appended');
  await expect(test.credentials.check(headers)).rejects.toThrow('Computer is not ready');
  await expect(test.credentials.turn(input)).rejects.toThrow('Computer is not ready');
}
it('refuses warm credentials after a suspension saved through another connection',
  refusesSuspensionFromAnotherConnection);
