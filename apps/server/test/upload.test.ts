import { z } from 'zod';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { uploadPdf } from './support/upload-pdf.ts';
import { expect, it } from 'vitest';
import { inspectFile } from '../src/files/types.ts';

it('accepts document content and refuses a disguised executable or archive', async () => {
  expect(await inspectFile('notes.txt', Buffer.from('Meeting at ten.'))).toBe('text/plain');
  await expect(inspectFile('notes.txt', Buffer.from('MZ\u0000\u0000binary'))).rejects.toThrow('Unsupported file type');
  await expect(inspectFile('notes.txt', Buffer.from('PK\u0003\u0004archive'))).rejects.toThrow();
});

it('refuses a cyclic FAT chain quickly while other HTTP requests stay responsive', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  // A separate process lets the watchdog stop the old synchronous parser safely.
  const source = `
    import cfb from 'cfb';
    import Fastify from 'fastify';
    import { inspectFile } from './apps/server/src/files/types.ts';
    const container = cfb.utils.cfb_new();
    cfb.utils.cfb_add(container, 'Workbook', Buffer.alloc(8192));
    const bytes = cfb.write(container, { type: 'buffer' });
    const directory = (bytes.readInt32LE(48) + 1) * 512;
    const fat = (bytes.readInt32LE(76) + 1) * 512;
    const start = bytes.readInt32LE(directory + 256 + 116);
    // Enter the middle of a chain that loops back to its first sector.
    bytes.writeInt32LE(start + 1, directory + 256 + 116);
    bytes.writeInt32LE(start, fat + (start + 15) * 4);
    const app = Fastify();
    app.get('/inspect', async (_request, reply) => {
      try { await inspectFile('cyclic.xls', bytes); return { accepted: true }; }
      catch (error) { return reply.code(415).send({ error: error.message }); }
    });
    app.get('/health', async () => ({ ok: true }));
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    const started = Date.now();
    const pending = fetch(url + '/inspect');
    await new Promise(resolve => setTimeout(resolve, 100));
    const healthStarted = Date.now();
    const health = await fetch(url + '/health');
    const healthMs = Date.now() - healthStarted;
    const response = await pending;
    process.stdout.write(JSON.stringify({ status: response.status, body: await response.json(),
      elapsed: Date.now() - started, health: await health.json(), healthMs }));
    await app.close();
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', source], { timeout: 8000 });
  const result = z.object({ status: z.number(), body: z.object({ error: z.string() }), elapsed: z.number(), health: z.object({ ok: z.boolean() }), healthMs: z.number() }).parse(JSON.parse(stdout) as unknown);
  expect(result.status).toBe(415);
  expect(result.body.error).toMatch(/inspection|Office document/iu);
  expect(result.elapsed).toBeLessThan(5000);
  expect(result.health).toEqual({ ok: true });
  expect(result.healthMs).toBeLessThan(500);
}, 12_000);

it('scans before storage, publishes only clean files and rebuilds its list from events', async () => {
  const { natsFixture } = await import('@opencrane/event-store/testing');
  const { databases, openfga } = await import('@opencrane/authz/testing');
  const { createStore, memberAuthorisation } = await import('@opencrane/authz');
  const { pgDb, ProjectionRunner, members, conversations, files, connectMemberFeed } = await import('@opencrane/projections');
  const { BudgetActor, envelope, history } = await import('@opencrane/models');
  const { createLogger } = await import('@opencrane/observability');
  const { encodeSession } = await import('@opencrane/auth');
  const { buildServer } = await import('../src/server.ts');
  const { testAuthConfig } = await import('./support/test-auth-config.ts');
  const { uploadServices } = await import('./support/upload-services.ts');
  const services = await uploadServices(), nats = await natsFixture(), dbs = await databases(), fga = await openfga();
  const config = { ...testAuthConfig(), expectedOrgId: 'org' }, binding = await createStore(fga.apiUrl, 'test');
  const db = pgDb(dbs.queue), auth = memberAuthorisation(binding), feed = await connectMemberFeed(dbs.queue.options.connectionString!);
  const options = { silo: 'test', store: nats.store, db, binding, feed, objects: services.objects, scan: services.scan };
  await new BudgetActor(nats.store, 'test').start(2000, 20000, 'personal-default');
  const runner = new ProjectionRunner(db, nats.store, createLogger('files', { level: 'silent' }));
  const app = buildServer(config, { files: options });
  const headers = { origin: new URL(config.redirectUri).origin, 'content-type': 'application/octet-stream', 'x-file-name': 'notes.txt', 'idempotency-key': 'upload',
    cookie: `${config.cookieName}=${encodeSession(config, { sub: 'alice', orgId: 'org', roles: [], authTime: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+300 })}` };
  const url = '/api/conversations/conversation/files';
  try {
    for (const [subject, type, data] of [
      ['member-alice', 'member.invited', { memberId: 'alice', invitationId: 'invite', email: 'a@example.test', role: 'member', invitedBy: 'owner', invitedIdentity: { issuer: config.issuerUrl, sub: 'alice' } }],
      ['member-alice', 'member.joined', { memberId: 'alice', invitationId: 'invite', email: 'a@example.test', role: 'member', displayName: 'Alice' }],
      ['assistant-assistant', 'assistant.created', { assistantId: 'assistant', ownerId: 'alice', kind: 'personal' }],
      ['conversation-conversation', 'conversation.created', { conversationId: 'conversation', assistantId: 'assistant', createdBy: 'alice', mode: 'agent_session' }],
    ] as const) {
      const event = envelope('test', subject, type, data); event.principal = { id: 'alice', kind: 'human' };
      await nats.store.append({ event, expectedSequence: (await history(nats.store, subject, 'test')).at(-1)?.sequence ?? 0 });
      if (type !== 'member.invited') await auth.handler.handle(event, db);
    }
    for (const [conversationId, createdBy, mode] of [['other', 'bob', 'agent_session'], ['direct', 'alice', 'direct'], ['closed', 'alice', 'agent_session']]) {
      const created = envelope('test', `conversation-${conversationId}`, 'conversation.created', { conversationId, assistantId: 'assistant', createdBy, mode });
      await nats.store.append({ event: created, expectedSequence: 0 }); await auth.handler.handle(created, db);
      if (createdBy === 'bob') {
        const joined = envelope('test', `conversation-${conversationId}`, 'participant.added', { conversationId, participantId: 'alice', addedBy: 'bob' });
        await nats.store.append({ event: joined, expectedSequence: (await history(nats.store, created.subject, 'test')).at(-1)!.sequence }); await auth.handler.handle(joined, db);
      }
      if (conversationId === 'closed') await nats.store.append({ expectedSequence: (await history(nats.store, created.subject, 'test')).at(-1)!.sequence,
        event: envelope('test', created.subject, 'conversation.closed', { conversationId, closedBy: 'alice' }) });
    }
    for (const projection of [members, conversations, files]) { await runner.initialise(projection); await runner.run(projection); }
    for (const conversationId of ['other', 'direct', 'closed']) {
      expect((await app.inject({ method: 'POST', url: `/api/conversations/${conversationId}/files`, headers, payload: Buffer.from('No access') })).statusCode).toBe(403);
      expect((await app.inject({ url: `/api/conversations/${conversationId}/files`, headers })).statusCode).toBe(403);
    }
    expect((await app.inject({ method: 'POST', url, headers, payload: Buffer.from('Meeting at ten.') })).statusCode).toBe(201);
    await runner.run(files);
    const list = await app.inject({ url, headers });
    expect(list.statusCode).toBe(200); expect(list.json()).toMatchObject({ rows: [{ name: 'notes.txt', status: 'uploaded', size: 15 }] });
    const path = (list.json<{ rows: { path: string }[] }>().rows[0]!).path;
    const previewUrl = `${url}/view?path=${encodeURIComponent(path)}&preview=true`;
    const preview = await app.inject({ url: previewUrl, headers });
    expect(preview.statusCode).toBe(200);
    expect(preview.body).toBe('Meeting at ten.');
    expect(preview.headers['content-type']).toContain('text/plain');
    expect(preview.headers['x-content-type-options']).toBe('nosniff');
    expect((await app.inject({ url: previewUrl, headers: { ...headers, cookie: '' } })).statusCode).toBe(401);
    expect((await app.inject({ url: `${url}/view?path=../../private`, headers })).statusCode).toBe(404);
    expect((await app.inject({ url: `/api/conversations/other/files/view?path=${encodeURIComponent(path)}`, headers })).statusCode).toBe(403);
    await runner.rebuild(files);
    expect((await app.inject({ url, headers })).json()).toEqual(list.json());
    expect(await services.client.listObjectsV2('quarantine', '', true).toArray()).toEqual([]);
    const eicar = Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');
    const infected = await app.inject({ method: 'POST', url, headers: { ...headers, 'idempotency-key': 'infected' }, payload: eicar });
    expect(infected.statusCode).toBe(422); expect(infected.body).toContain('malware detected');
    expect((await history(nats.store, 'conversation-conversation', 'test')).filter(row => row.event.type === 'file.rejected')).toHaveLength(1);
    await runner.run(files);
    expect((await app.inject({ url, headers })).json()).toEqual(list.json());
    expect(await services.client.listObjectsV2('quarantine', '', true).toArray()).toEqual([]);
    expect(await services.client.listObjectsV2('files', '', true).toArray()).toHaveLength(1);
    expect((await app.inject({ method: 'POST', url, headers, payload: Buffer.from('Meeting at ten.') })).statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', url, headers, payload: Buffer.from('Different') })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url, headers: { ...headers, cookie: '' }, payload: Buffer.from('test') })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url, headers: { ...headers, origin: 'https://other.test' }, payload: Buffer.from('test') })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url, headers: { ...headers, 'x-file-name': 'escape.exe' }, payload: Buffer.from('MZbinary') })).statusCode).toBe(415);
    expect((await app.inject({ method: 'POST', url, headers, payload: Buffer.alloc(20 * 1024 * 1024 + 1) })).statusCode).toBe(413);
    const { until: wait } = await import('@opencrane/authz/testing');
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    let scanning = false;
    options.scan = async bytes => { scanning = true; await gate; return services.scan(bytes); };
    const pending = app.inject({ method: 'POST', url, headers: { ...headers, 'idempotency-key': 'pending' }, payload: Buffer.from('Held until scan') });
    await wait(() => Promise.resolve(scanning));
    try {
      expect(await services.client.listObjectsV2('quarantine', '', true).toArray()).toEqual([]);
      expect(await services.client.listObjectsV2('files', '', true).toArray()).toHaveLength(1);
    } finally { release(); }
    expect((await app.inject({ url, headers })).json()).toEqual(list.json());
    release(); expect((await pending).statusCode).toBe(201);
    options.scan = () => Promise.reject(new Error('Scanner unavailable'));
    expect((await app.inject({ method: 'POST', url, headers: { ...headers, 'idempotency-key': 'offline' }, payload: Buffer.from('No scan means no file') })).statusCode).toBe(503);
    expect(await services.client.listObjectsV2('quarantine', '', true).toArray()).toEqual([]);
    options.scan = services.scan;
    const concurrent = await Promise.all(['Left', 'Right'].map(text => app.inject({ method: 'POST', url, headers: { ...headers, 'idempotency-key': 'race' }, payload: Buffer.from(text) })));
    expect(concurrent.map(reply => reply.statusCode).sort()).toEqual([201, 409]);
    const racedUploads = (await history(nats.store, 'conversation-conversation', 'test')).filter(row => row.event.type === 'file.uploaded');
    expect(racedUploads).toHaveLength(3);

    expect((await app.inject({ method: 'POST', url, headers: { ...headers, 'idempotency-key': 'pdf', 'x-file-name': 'project.pdf' }, payload: uploadPdf() })).statusCode).toBe(201);
    const { fileUploadedDataSchema } = await import('@opencrane/events');
    const { uploadComputer } = await import('./support/upload-computer.ts');
    const { connectBridge } = await import('../src/chat/bridge.ts');
    const { conversationKeys } = await import('../src/chat/keys.ts');
    const { chatCommand } = await import('../src/chat/commands.ts');
    const { tokenIssuer } = await import('@opencrane/auth');
    const { generateKeyPairSync } = await import('node:crypto');
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { until } = await import('@opencrane/authz/testing');
    const directory = await mkdtemp(`${tmpdir()}/upload-codex-`), computer = await uploadComputer();
    const key = generateKeyPairSync('ec', { namedCurve: 'P-256', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    await writeFile(`${directory}/key`, key.privateKey, { mode: 0o600 });
    const tokens = await tokenIssuer({ privateKeyPath: `${directory}/key`, issuer: 'https://upload.test/' });
    const keys = conversationKeys(`${directory}/keys`); keys.provision('test', 'conversation');
    for (const type of ['computer.claimed', 'computer.ready']) {
      await nats.store.append({ expectedSequence: (await history(nats.store, 'computer-assistant', 'test')).at(-1)?.sequence ?? 0,
        event: envelope('test', 'computer-assistant', type, { computerId: 'computer', assistantId: 'assistant', generation: 1,
          ...(type === 'computer.claimed' ? { tokenId: 'token:test' } : { podUid: 'pod' }) }) });
    }
    const connection = { url: `${computer.url.replace('http:', 'ws:')}/bridge`, computerId: 'computer', assistantId: 'assistant', bearer: 'test-computer' };
    let link = await connectBridge({ ...options, keys }, connection, tokens);
    try {
      const row = (await history(nats.store, 'conversation-conversation', 'test')).findLast(row => row.event.type === 'file.uploaded')!;
      const file = fileUploadedDataSchema.parse(row.event.data);
      const stream = await services.client.getObject('files', file.objectKey), bytes = Buffer.concat(z.array(z.instanceof(Buffer)).parse(await stream.toArray()));
      await link.deliver(file, bytes);
      const path = `/workspace/uploads/conversation/${file.fileId}/project.pdf`;
      const editedPdf = 'Member edits to the original PDF', editedText = 'Project code: Willow-47. Member edits survive.';
      await computer.write(path, editedPdf); await computer.write(path + '.md', editedText);
      // An ambiguous acknowledgement can still retry: the receiver must keep edits too.
      const { sendFile } = await import('../src/files/delivery.ts');
      expect(await sendFile(link.socket, file, bytes)).toBe('kept_existing');
      expect(await computer.read(path)).toBe(editedPdf);
      expect(await computer.read(path + '.md')).toBe(editedText);
      const modified = await computer.mtime(path);
      const conflictFile = fileUploadedDataSchema.parse(racedUploads[0]!.event.data);
      const conflictStream = await services.client.getObject('files', conflictFile.objectKey);
      const conflictBytes = Buffer.concat(z.array(z.instanceof(Buffer)).parse(await conflictStream.toArray()));
      const conflictPath = `/workspace/uploads/conversation/${conflictFile.fileId}/${conflictFile.name}`;
      await computer.write(conflictPath, 'Member notes kept on first delivery');
      await link.deliver(conflictFile, conflictBytes);
      expect(await computer.read(conflictPath)).toBe('Member notes kept on first delivery');
      link.socket.terminate(); await once(link.socket, 'close'); await link.settled();
      const { suspendComputer, resumeComputer } = await import('../../ops/src/lifecycle.ts');
      const latest = (await history(nats.store, 'computer-assistant', 'test')).at(-1)!.event;
      expect((await suspendComputer(nats.store, { computerId: 'computer', assistantId: 'assistant', latest })).type).toBe('computer.suspended');
      await computer.pause(); await computer.resume(); await computer.restart();
      await resumeComputer(nats.store, tokens, 'test', 'assistant');
      expect((await history(nats.store, 'computer-assistant', 'test')).at(-1)!.event.type).toBe('computer.resumed');
      await nats.store.append({ expectedSequence: (await history(nats.store, 'computer-assistant', 'test')).at(-1)!.sequence,
        event: envelope('test', 'computer-assistant', 'computer.ready', { computerId: 'computer', assistantId: 'assistant', generation: 1, podUid: 'replacement' }) });
      connection.url = `${computer.url.replace('http:', 'ws:')}/bridge`;
      link = await connectBridge({ ...options, keys }, connection, tokens);
      await link.deliver(file, bytes);
      expect(await computer.mtime(path)).toBe(modified);
      expect(await computer.read(path)).toBe(editedPdf);
      expect(await computer.read(path + '.md')).toBe(editedText);
      await chatCommand(nats.store, keys, { silo: 'test', memberId: 'alice' }, { id: 'read-pdf', conversationId: 'conversation', text: 'Read the uploaded PDF.' });
      link.socket.send(JSON.stringify({ type: 'turn', id: 'read-pdf', conversationId: 'conversation', assistantId: 'assistant',
        text: `UPLOAD_PDF_PROOF Read ${path}.md and tell me the project code.`, token: 'preparing', expiresAt: Date.now()+120_000 }));
      await until(async () => (await history(nats.store, 'conversation-conversation', 'test')).some(row => row.event.type === 'agent.turn_completed'), 60_000);
      const answer = (await history(nats.store, 'conversation-conversation', 'test')).findLast(row => row.event.type === 'agent.message_completed')!;
      expect(keys.decrypt('test', 'conversation', answer.event.data)).toContain('The project code is Willow-47.');
      expect(await computer.read(path)).toBe(editedPdf);
      expect(await computer.read(path + '.md')).toBe(editedText);
      await runner.run(files);
      await runner.rebuild(files);
      expect((await app.inject({ url, headers })).json()).toMatchObject({ rows: [{ status: 'delivered', deliveryOutcome: 'kept_existing' }, {}, {}, { status: 'delivered', name: 'project.pdf', deliveryOutcome: 'saved' }] });
    } finally { link.socket.terminate(); await link.settled(); await computer.close(); await rm(directory, { recursive: true, force: true }); }

  } finally { await app.close(); await feed.close(); await fga.close(); await nats.close(); await dbs.close(); await services.close(); }
}, 180_000);

it('does not resend acknowledged uploads after reconnect even when workspace bytes changed', async () => {
  const { createServer } = await import('node:http');
  const { createHash } = await import('node:crypto');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { bridgeChannel } = await import('../../computer/src/channel.ts');
  const { natsFixture } = await import('@opencrane/event-store/testing');
  const { connectBridge } = await import('../src/chat/bridge.ts');
  const { chatCommand, chatHistory } = await import('../src/chat/commands.ts');
  const { conversationKeys } = await import('../src/chat/keys.ts');
  const { fileCommand } = await import('../src/files/commands.ts');
  const directory = await mkdtemp(`${tmpdir()}/file-bridge-`), server = createServer(), nats = await natsFixture();
  const keys = conversationKeys(directory); keys.provision('test', 'conversation');
  await chatCommand(nats.store, keys, { silo: 'test', memberId: 'alice' }, { id: 'create', conversationId: 'conversation', assistantId: 'assistant' });
  const bytes = Buffer.alloc(160_000, 'a'), sha256 = createHash('sha256').update(bytes).digest('hex');
  const file = { conversationId: 'conversation', fileId: 'file', name: 'notes.txt', mime: 'text/plain', size: bytes.length, sha256, objectKey: 'test/file', uploadedBy: 'alice' };
  await fileCommand(nats.store, 'test', 'alice', 'upload', 'file.uploaded', file);
  let writes = 0;
  let workspace: Buffer = Buffer.alloc(0);
  const channel = bridgeChannel(server, { journal: `${directory}/reports`, rpc: () => Promise.resolve({}), grant: () => Promise.resolve(),
    credential: () => ({ value: 'computer', expiresAt: Date.now()+60_000 }),
    file(_metadata, content) { expect(content).toEqual(bytes); workspace = content; writes++; return Promise.resolve(); },
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port');
  let link: Awaited<ReturnType<typeof connectBridge>> | undefined;
  try {
    for (let i = 0; i < 2; i++) {
      link = await connectBridge({ silo: 'test', store: nats.store, keys }, { url: `ws://127.0.0.1:${address.port}/bridge`,
        computerId: 'computer', assistantId: 'assistant', bearer: 'computer' });
      await link.deliver(file, bytes);
      expect(writes).toBe(1);
      expect(workspace.toString()).toBe(i === 0 ? bytes.toString() : 'Member edits');
      workspace = Buffer.from('Member edits');
      link.socket.terminate(); await once(link.socket, 'close'); await link.settled();
    }
    expect((await chatHistory(nats.store, 'test', 'conversation')).filter(row => row.event.type === 'file.delivered')).toHaveLength(1);
  } finally { link?.socket.terminate(); await link?.settled(); await channel.close(); server.close(); await nats.close(); await rm(directory, { recursive: true, force: true }); }
}, 20_000);

it('refuses a malformed delivery acknowledgement without crashing the server', async () => {
  const { createServer } = await import('node:http');
  const { WebSocketServer } = await import('ws');
  const { sendFile } = await import('../src/files/delivery.ts');
  const server = createServer(), wss = new WebSocketServer({ server });
  wss.on('connection', peer => peer.on('message', () => peer.send('{')));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port');
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
  await once(socket, 'open');
  try {
    await expect(sendFile(socket, { conversationId: 'conversation', fileId: 'file', name: 'notes.txt', mime: 'text/plain', size: 1,
      sha256: 'a'.repeat(64), objectKey: 'test/file', uploadedBy: 'alice' }, Buffer.from('a'))).rejects.toThrow('Invalid file receipt');
  } finally { socket.terminate(); for (const peer of wss.clients) peer.terminate(); await new Promise<void>(resolve => wss.close(() => resolve())); server.close(); }
});

it('refuses Excel macro parts even in a document with an xlsx filename', async () => {
  const cfb = await import('cfb');
  const zip = cfb.utils.cfb_new();
  cfb.utils.cfb_add(zip, '[Content_Types].xml', Buffer.from('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/macrosheets/sheet1.xml" ContentType="application/vnd.ms-excel.macrosheet+xml"/></Types>'));
  cfb.utils.cfb_add(zip, 'xl/workbook.xml', Buffer.from('<workbook/>'));
  cfb.utils.cfb_add(zip, 'xl/macrosheets/sheet1.xml', Buffer.from('<worksheet/>'));
  const bytes = z.instanceof(Buffer).parse(cfb.write(zip, { type: 'buffer', fileType: 'zip' }));
  await expect(inspectFile('macro.xlsx', bytes)).rejects.toThrow('Unsafe Office document');
});

it('refuses encoded macro declarations and encrypted or macro legacy workbooks', async () => {
  const cfb = await import('cfb');
  const zip = cfb.utils.cfb_new();
  cfb.utils.cfb_add(zip, '[Content_Types].xml', Buffer.from('<Types><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/sheet.xml" ContentType="application/vnd.ms-excel.macro&#115;heet+xml"/></Types>'));
  cfb.utils.cfb_add(zip, 'xl/workbook.xml', Buffer.from('<workbook/>'));
  cfb.utils.cfb_add(zip, 'xl/sheet.xml', Buffer.from('<worksheet/>'));
  await expect(inspectFile('encoded.xlsx', z.instanceof(Buffer).parse(cfb.write(zip, { type: 'buffer', fileType: 'zip' })))).rejects.toThrow('Unsafe Office document');
  for (const content of [Buffer.from([0x85, 0, 6, 0, 0, 0, 0, 0, 0, 1]), Buffer.from([0x2f, 0, 0, 0])]) {
    const workbook = cfb.utils.cfb_new(); cfb.utils.cfb_add(workbook, 'Workbook', content);
    await expect(inspectFile('legacy.xls', z.instanceof(Buffer).parse(cfb.write(workbook, { type: 'buffer' })))).rejects.toThrow('Unsafe Office document');
  }
});
