import { z } from 'zod';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import { bridgeChannel } from '../../computer/test/server.ts';
import { pullArtifact } from '../src/files/artifacts.ts';
import { createHash } from 'node:crypto';
import { encodeSession } from '@opencrane/auth';
import { files } from '@opencrane/projections';
import { expect, it, vi } from 'vitest';
import { chatCommand, chatHistory } from '../src/chat/commands.ts';
import { recordReport } from '../src/chat/reports.ts';
import { buildServer } from '../src/server.ts';
import { viewFixture } from './support/view-fixture.ts';
import { uploadServices } from './support/upload-services.ts';

function unavailableDesktop(): Promise<never> {
  return Promise.reject(new Error('Desktop unused'));
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
  let currentBytes = bytes;
  const directory = await mkdtemp(`${tmpdir()}/artifact-bridge-`);
  const server = createServer();
  function readChunk(_id: string, offset: number) {
    return Promise.resolve(currentBytes.subarray(offset, offset + 32768));
  }
  async function grant() {}
  function rpc() { return Promise.resolve({}); }
  function credential() { return { value: 'fixture', expiresAt: Date.now() + 120_000 }; }
  const driver = { journal: `${directory}/reports`, readArtifact: readChunk, grant, rpc, credential };
  const channel = bridgeChannel(server, driver);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing port');
  const socketOptions = { headers: { 'x-bridge-token': 'fixture' } };
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/bridge`, socketOptions);
  await once(socket, 'open');
  socket.send(JSON.stringify({ type: 'resume', since: 0 }));
  const readArtifact = pullArtifact.bind(undefined, socket);
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
    const append = options.store.append.bind(options.store);
    async function interruptCard(command: Parameters<typeof append>[0]) {
      const event = z.object({ type: z.string() }).parse(command.event);
      if (event.type === 'agent.file_changed') throw new Error('Interrupted publication');
      return append(command);
    }
    const appends = vi.spyOn(options.store, 'append');
    appends.mockImplementation(interruptCard);
    await expect(recordReport(options.store, fixture.keys, context, report))
      .rejects.toThrow('Interrupted publication');
    appends.mockRestore();
    currentBytes = Buffer.alloc(0);
    expect(await recordReport(options.store, fixture.keys, context, report)).toBe('recorded');
    expect(await recordReport(options.store, fixture.keys, context, report)).toBe('duplicate');
    const rows = await chatHistory(options.store, 'test', 'chat');
    function isCard(row: typeof rows[number]) { return row.event.type === 'agent.file_changed'; }
    const cards = rows.filter(isCard);
    expect(cards).toHaveLength(1);
    const data = z.object({ path: z.string() }).parse(cards[0]!.event.data);
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
    const refusals = [
      { name: 'unsafe.svg', bytes: Buffer.from('<svg><script>alert(1)</script></svg>'),
        reason: 'unsupported_type' },
      { name: 'infected.txt', bytes: Buffer.from(
        'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'), reason: 'infected' },
    ];
    let sequence = 1;
    for (const refusal of refusals) {
      currentBytes = refusal.bytes;
      const digest = createHash('sha256');
      digest.update(currentBytes);
      const changed = { ...artifact, name: refusal.name, size: currentBytes.length,
        sha256: digest.digest('hex') };
      const turnId = `refusal-${sequence}`;
      const request = { id: turnId, conversationId: 'chat', text: 'Create another file' };
      await chatCommand(options.store, fixture.keys, person, request);
      const refused = { ...report, previousSequence: sequence, sequence: ++sequence,
        turnId, artifacts: [changed] };
      expect(await recordReport(options.store, fixture.keys, context, refused)).toBe('recorded');
      const saved = await chatHistory(options.store, 'test', 'chat');
      const cards = saved.filter(isCard);
      expect(cards.at(-1)?.event.data).toMatchObject({ path: 'unavailable',
        changeType: 'deleted', reason: refusal.reason });
    }
    const tooLarge = { ...report, previousSequence: sequence, sequence: sequence + 1,
      artifacts: [{ ...artifact, size: 20 * 1024 * 1024 + 1 }] };
    await expect(recordReport(options.store, fixture.keys, context, tooLarge)).rejects.toThrow();
  } finally {
    socket.terminate();
    await channel.close();
    server.close();
    await rm(directory, { recursive: true, force: true });
    await app.close();
    await services.close();
    await fixture.close();
  }
}
it('publishes an assistant file once and downloads it only with conversation access',
  publishesAssistantFiles, 180_000);
