import { generateKeyPairSync } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { expect, it } from 'vitest';
import { computerCredentials, tokenIssuer } from '@opencrane/auth';
import { countReads, expectNoWholeReads, natsFixture } from '@opencrane/event-store/testing';
import { BudgetActor, envelope, priceTableId } from '@opencrane/models';
import { conversationKeys } from '../src/chat/keys.ts';
import { recordReport } from '../src/chat/reports.ts';
import { turnCommand } from '../src/chat/turns.ts';

async function admissionGrowth(longChat: boolean) {
  const nats = await natsFixture();
  try {
    const store = nats.store;
    const directory = dirname(nats.env().NATS_CA_FILE);
    const keyOptions = { namedCurve: 'P-256',
      privateKeyEncoding: { type: 'pkcs8' as const, format: 'pem' as const },
      publicKeyEncoding: { type: 'spki' as const, format: 'pem' as const } };
    const key = generateKeyPairSync('ec', keyOptions);
    const privateKeyPath = `${directory}/signing.pem`;
    await writeFile(privateKeyPath, key.privateKey, { mode: 0o600 });
    const tokens = await tokenIssuer({ privateKeyPath, issuer: 'https://test.invalid' });
    const computer = await tokens.computer({ silo: 'test', assistantId: 'assistant',
      computerId: 'computer', generation: 1 });
    const credentials = computerCredentials(store, tokens, 'test');
    const keys = conversationKeys(`${directory}/keys`);
    const positions = new Map<string, number>();
    async function append(subject: string, type: string, data: unknown, id: string) {
      const event = envelope('test', subject, type, data, id);
      const command = { event, expectedSequence: positions.get(subject) ?? 0,
        historyChecked: true as const };
      const result = await store.append(command);
      expect(result.status).toBe('appended');
      if (result.status !== 'appended') throw new Error('Fixture append refused');
      positions.set(subject, result.sequence);
    }
    const identity = { assistantId: 'assistant', computerId: 'computer', generation: 1 };
    await append('assistant-assistant', 'assistant.created', {
      assistantId: 'assistant', ownerId: 'alice', kind: 'personal',
    }, 'assistant');
    await append('computer-assistant', 'computer.claimed', {
      ...identity, tokenId: computer.id,
    }, 'claim');
    await append('computer-assistant', 'computer.ready', identity, 'ready');
    await append('budget-test', 'budget.ceiling_set', { scope: 'global',
      dailyCeilingCents: 100_000_000, ceilingCents: 100_000_000, setBy: 'installation',
      defaultPayingGroupId: 'personal' }, 'budget');
    async function createChat(conversationId: string) {
      keys.provision('test', conversationId);
      await append(`conversation-${conversationId}`, 'conversation.created', {
        conversationId, assistantId: 'assistant', createdBy: 'alice', mode: 'agent_session',
      }, `create-${conversationId}`);
    }
    async function post(conversationId: string, turnId: string) {
      const text = keys.encrypt('test', conversationId, 'Hello');
      await append(`conversation-${conversationId}`, 'message.posted', {
        conversationId, authorId: 'alice', authorKind: 'human', contentType: 'text', ...text,
      }, turnId);
    }
    if (longChat) {
      await createChat('long');
      await post('long', 'initial-message');
      for (let index = 0; index < 498; index++) {
        await append('conversation-long', 'agent.output_lost', {
          conversationId: 'long', turnId: 'initial-message',
        }, `output-${index}`);
      }
    }
    let earlierTurns = 0;
    let reportSequence = 0;
    let previousLongReport = 0;
    const context = { silo: 'test', assistantId: 'assistant', computerId: 'computer' };
    const reads = countReads(store);
    const measuredReads: (typeof reads.calls)[] = [];
    const measurements: { turns: number; rows: number; milliseconds: number }[] = [];
    async function seedTurn() {
      const turnId = `seed-${earlierTurns}`;
      let conversationId = 'long';
      if (!longChat) {
        conversationId = `chat-${turnId}`;
        await createChat(conversationId);
        await post(conversationId, turnId);
      }
      const started = { assistantId: 'assistant', computerId: 'computer',
        conversationId, turnId, threadId: `thread-${conversationId}`,
        requesterId: 'alice', task: 'chat_turn', executionMode: 'memory_free' };
      await append('computer-assistant', 'computer.turn_started', started, `start-${turnId}`);
      await append('computer-assistant', 'computer.turn_closed', {
        ...started, status: 'completed',
      }, `close-${turnId}`);
      await append('budget-test', 'budget.period_started', {
        periodStart: `${new Date().toISOString().slice(0, 7)}-01T00:00:00.000Z`,
      }, `period-${turnId}`);
      earlierTurns++;
    }
    async function oneAdmission(name: string, actor: BudgetActor, measured: boolean) {
      const conversationId = longChat ? 'long' : name;
      if (!longChat) await createChat(conversationId);
      const turnId = `message-${name}`;
      await post(conversationId, turnId);
      const start = { sequence: ++reportSequence, previousSequence: longChat ? previousLongReport : 0,
        conversationId, turnId, assistantId: 'assistant', type: 'agent.turn_started',
        threadId: `thread-${conversationId}`, requesterId: 'alice' };
      reads.clear();
      const began = performance.now();
      expect(await recordReport(store, keys, context, start)).toBe('recorded');
      const admitted = await turnCommand(store, context, { ...start, status: 'started' });
      expect(admitted).toMatchObject({ payingGroupId: 'personal', executionMode: 'memory_free' });
      const credentialReadStart = reads.calls.length;
      const grant = await credentials.turn({ ...start, task: 'chat_turn', model: 'gpt-6-luna' });
      expect(grant.value).toBeTruthy();
      const credentialReads = reads.calls.slice(credentialReadStart);
      let credentialRows = 0;
      for (const read of credentialReads) credentialRows += read.rows;
      expect(credentialRows).toBeLessThanOrEqual(2);
      const call = { model: 'gpt-6-luna', priceTableId, computerId: 'computer',
        assistantId: 'assistant', requesterId: 'alice', conversationId, turnId,
        threadId: start.threadId, payingGroupId: 'personal', contextDigest: '0'.repeat(64) };
      expect(await actor.reserve(call, 1)).toBeTruthy();
      if (measured) {
        const milliseconds = Math.round(performance.now() - began);
        let rows = 0;
        for (const read of reads.calls) rows += read.rows;
        measurements.push({ turns: earlierTurns, rows, milliseconds });
        measuredReads.push([...reads.calls]);
      }
      if (longChat) previousLongReport = start.sequence;
      await turnCommand(store, context, { ...start, status: 'completed' });
      positions.set('computer-assistant', await store.head('computer-assistant'));
      positions.set('budget-test', await store.head('budget-test'));
      positions.set(`conversation-${conversationId}`, await store.head(`conversation-${conversationId}`));
      earlierTurns++;
    }
    for (const target of [10, 100, 500]) {
      while (earlierTurns < target - 1) await seedTurn();
      const actor = new BudgetActor(store, 'test');
      await actor.start();
      positions.set('budget-test', await store.head('budget-test'));
      await oneAdmission(`warm-${target}`, actor, false);
      await oneAdmission(`measured-${target}`, actor, true);
    }
    console.info(JSON.stringify({ shape: longChat ? '500-event chat' : 'new chat', measurements }));
    expect(measurements[2]?.rows).toBeLessThanOrEqual((measurements[0]?.rows ?? 0) + 2);
    for (const calls of measuredReads) expectNoWholeReads(calls);
  } finally {
    await nats.close();
  }
}
it.each([false, true])('keeps admission reads flat at 10, 100 and 500 turns, long chat=%s',
  admissionGrowth, 120_000);
