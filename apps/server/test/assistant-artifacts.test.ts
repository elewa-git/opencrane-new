import { createHash } from 'node:crypto';
import { z } from 'zod';
import { expect, it, vi } from 'vitest';
import { chatCommand, chatHistory } from '../src/chat/commands.ts';
import { recordReport } from '../src/chat/reports.ts';
import { viewFixture } from './support/view-fixture.ts';
import { uploadServices } from './support/upload-services.ts';

function unavailableDesktop(): Promise<never> {
  return Promise.reject(new Error('Desktop unused'));
}

async function publicationFixture(bytes: Buffer) {
  const fixture = await viewFixture(unavailableDesktop);
  const services = await uploadServices();
  const options = { silo: 'test', store: fixture.nats.store, db: fixture.db,
    feed: fixture.feed, binding: fixture.binding, ...services };
  function readArtifact() { return Promise.resolve(bytes); }
  const context = { silo: 'test', computerId: 'desktop', assistantId: 'assistant',
    files: options, readArtifact };
  fixture.keys.provision('test', 'chat');
  const person = { silo: 'test', memberId: 'alice' };
  const message = { id: 'request', conversationId: 'chat', text: 'Create reports' };
  await chatCommand(options.store, fixture.keys, person, message);
  const digest = createHash('sha256');
  digest.update(bytes);
  const artifact = { id: 'a'.repeat(64), name: 'report.txt', size: bytes.length,
    sha256: digest.digest('hex') };
  const report = { sequence: 1, previousSequence: 0, conversationId: 'chat',
    turnId: 'request', assistantId: 'assistant', type: 'agent.turn_completed',
    artifacts: [artifact] };
  function record(value: unknown) {
    return recordReport(options.store, fixture.keys, context, value);
  }
  async function close() {
    await services.close();
    await fixture.close();
  }
  return { store: options.store, report, artifact, record, close };
}

async function keepsAllowanceAfterPartialPublication() {
  const bytes = Buffer.alloc(12 * 1024 * 1024, 'a');
  const fixture = await publicationFixture(bytes);
  try {
    const second = { ...fixture.artifact, id: 'b'.repeat(64), name: 'second.txt' };
    const report = { ...fixture.report, artifacts: [fixture.artifact, second] };
    const append = fixture.store.append.bind(fixture.store);
    async function interruptRefusal(command: Parameters<typeof append>[0]) {
      const event = z.object({ type: z.string(), data: z.unknown() }).parse(command.event);
      if (event.type === 'agent.file_changed') {
        const data = z.object({ reason: z.string().optional() }).parse(event.data);
        if (data.reason === 'too_large') throw new Error('Interrupted refusal');
      }
      return append(command);
    }
    const appends = vi.spyOn(fixture.store, 'append');
    appends.mockImplementation(interruptRefusal);
    await expect(fixture.record(report)).rejects.toThrow('Interrupted refusal');
    appends.mockRestore();
    await fixture.record(report);
    await fixture.record(report);
    const rows = await chatHistory(fixture.store, 'test', 'chat');
    function isUpload(row: typeof rows[number]) { return row.event.type === 'file.uploaded'; }
    function isCard(row: typeof rows[number]) { return row.event.type === 'agent.file_changed'; }
    expect(rows.filter(isUpload)).toHaveLength(1);
    const cards = rows.filter(isCard);
    expect(cards).toHaveLength(2);
    expect(cards[1]!.event.data).toMatchObject({ reason: 'too_large', path: 'unavailable' });
  } finally {
    vi.restoreAllMocks();
    await fixture.close();
  }
}
it('keeps the turn byte allowance after a partial publication and exact retries',
  keepsAllowanceAfterPartialPublication, 180_000);

async function refusesChangedPublication(interrupted: boolean) {
  const fixture = await publicationFixture(Buffer.from('A report'));
  try {
    if (interrupted) {
      const append = fixture.store.append.bind(fixture.store);
      async function interruptCard(command: Parameters<typeof append>[0]) {
        const event = z.object({ type: z.string() }).parse(command.event);
        if (event.type === 'agent.file_changed') throw new Error('Interrupted card');
        return append(command);
      }
      const appends = vi.spyOn(fixture.store, 'append');
      appends.mockImplementation(interruptCard);
      await expect(fixture.record(fixture.report)).rejects.toThrow('Interrupted card');
      appends.mockRestore();
    } else {
      expect(await fixture.record(fixture.report)).toBe('recorded');
    }
    const changedName = { ...fixture.artifact, name: 'renamed.txt' };
    const changedDigest = { ...fixture.artifact, sha256: 'c'.repeat(64) };
    const additional = { ...fixture.artifact, id: 'b'.repeat(64), name: 'additional.txt' };
    const changedSets = [[changedName], [changedDigest], [additional],
      [fixture.artifact, additional]];
    for (const artifacts of changedSets) {
      const changed = { ...fixture.report, sequence: 2, previousSequence: 1, artifacts };
      let changedReason = 'Artifact report refused';
      let reusedReason = 'Report sequence reused';
      if (interrupted) {
        changedReason = 'Report sequence gap';
        reusedReason = 'Artifact publication set changed';
      }
      await expect(fixture.record(changed)).rejects.toThrow(changedReason);
      const reusedSequence = { ...fixture.report, artifacts };
      await expect(fixture.record(reusedSequence)).rejects.toThrow(reusedReason);
    }
    await fixture.record(fixture.report);
    expect(await fixture.record(fixture.report)).toBe('duplicate');
    const rows = await chatHistory(fixture.store, 'test', 'chat');
    function isUpload(row: typeof rows[number]) { return row.event.type === 'file.uploaded'; }
    function isCard(row: typeof rows[number]) { return row.event.type === 'agent.file_changed'; }
    expect(rows.filter(isUpload)).toHaveLength(1);
    expect(rows.filter(isCard)).toHaveLength(1);
  } finally {
    vi.restoreAllMocks();
    await fixture.close();
  }
}
it.each([false, true])(
  'refuses changed and additional publication sets while keeping exact retries (interrupted: %s)',
  refusesChangedPublication, 180_000);
