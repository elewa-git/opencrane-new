import { createHash } from 'node:crypto';
import { encodeSession } from '@opencrane/auth';
import { files } from '@opencrane/projections';
import { expect, it } from 'vitest';
import { chatCommand, chatHistory } from '../src/chat/commands.ts';
import { recordReport } from '../src/chat/reports.ts';
import { buildServer } from '../src/server.ts';
import { viewFixture } from './support/view-fixture.ts';
import { uploadServices } from './support/upload-services.ts';

async function unavailableDesktop(): Promise<never> {
  throw new Error('Desktop unused');
}

async function publishesAssistantFiles() {
  const fixture = await viewFixture(unavailableDesktop);
  const services = await uploadServices();
  const options = { silo: 'test', store: fixture.nats.store, db: fixture.db,
    feed: fixture.feed, binding: fixture.binding, ...services };
  const app = buildServer(fixture.config, { files: options });
  const bytes = Buffer.from('A sample assistant report.');
  const hash = createHash('sha256');
  hash.update(bytes);
  const artifact = { id: 'a'.repeat(64), name: 'report.txt', size: bytes.length,
    sha256: hash.digest('hex') };
  async function readArtifact() { return bytes; }
  const context = { silo: 'test', computerId: 'desktop', assistantId: 'assistant',
    files: options, readArtifact };
  try {
    fixture.keys.provision('test', 'chat');
    const person = { silo: 'test', memberId: 'alice' };
    const message = { id: 'request', conversationId: 'chat', text: 'Create a report' };
    await chatCommand(options.store, fixture.keys, person, message);
    const report = { sequence: 1, previousSequence: 0, conversationId: 'chat',
      turnId: 'request', assistantId: 'assistant', type: 'agent.turn_completed',
      artifacts: [artifact] };
    expect(await recordReport(options.store, fixture.keys, context, report)).toBe('recorded');
    expect(await recordReport(options.store, fixture.keys, context, report)).toBe('duplicate');
    const rows = await chatHistory(options.store, 'test', 'chat');
    function isCard(row: typeof rows[number]) { return row.event.type === 'agent.file_changed'; }
    const cards = rows.filter(isCard);
    expect(cards).toHaveLength(1);
    const data = cards[0]!.event.data as { path: string };
    await fixture.runner.initialise(files);
    await fixture.runner.run(files);
    await fixture.runner.run((await import('@opencrane/projections')).conversations);
    for (const memberId of ['alice', 'bob']) {
      const now = Math.floor(Date.now() / 1000);
      const session = { sub: memberId, orgId: 'org-test', roles: [], authTime: now, exp: now + 300 };
      const cookie = encodeSession(fixture.config, session);
      const request = { url: `/api/conversations/chat/files/view?path=${data.path}`,
        headers: { cookie: `${fixture.config.cookieName}=${cookie}` } };
      const response = await app.inject(request);
      expect(response.statusCode).toBe(memberId === 'alice' ? 200 : 403);
      if (memberId === 'alice') expect(response.rawPayload).toEqual(bytes);
    }
    expect(JSON.stringify(rows)).not.toContain(bytes.toString());
  } finally {
    await app.close();
    await services.close();
    await fixture.close();
  }
}
it('publishes an assistant file once and downloads it only with conversation access',
  publishesAssistantFiles, 180_000);
