import { once } from 'node:events';
import { z } from 'zod';
import { it, expect } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { grantStream } from '@opencrane/authz';
import { history } from '@opencrane/models';
import { viewFixture } from './support/view-fixture.ts';

it('only grants the requester control after the whole computer is paused and the intent is durable', async () => {
  let paused = false;
  const fixture = await viewFixture(() => { throw new Error('No tunnel expected'); }, undefined, async (_computer, action) => {
    if (action === 'pause') {
      expect((await history(fixture.nats.store, 'computer-assistant', 'test')).at(-1)?.event.type).toBe('takeover.requested');
      paused = true;
    }
  });
  try {
    for (const member of ['alice', 'bob']) await fixture.append(grantStream('shared_desktop', 'desktop'), 'grant.given',
      { resourceType: 'shared_desktop', resourceId: 'desktop', granteeId: member, granteeKind: 'member', grantedBy: 'owner' }, true);
    await fixture.append('conversation-chat', 'participant.added', { conversationId: 'chat', participantId: 'bob', addedBy: 'alice' }, true);
    fixture.keys.provision('test', 'chat');
    await fixture.append('conversation-chat', 'message.posted', { conversationId: 'chat', authorId: 'alice', authorKind: 'human', contentType: 'text', ...fixture.keys.encrypt('test', 'chat', 'Help me log in') });
    const request = (member: string) => fixture.app.inject({ method: 'POST', url: '/api/conversations/chat/control', headers: {
      origin: new URL(fixture.config.redirectUri).origin, 'x-opencrane-view': '1', cookie: `${fixture.config.cookieName}=${encodeSession(fixture.config, { sub: member, orgId: 'org-test', roles: member === 'bob' ? ['admin'] : [], authTime: 1, exp: Math.floor(Date.now()/1000)+300 })}`,
    } });
    expect((await request('bob')).statusCode).toBe(403);
    const controllers = await Promise.all([request('alice'), request('alice')]);
    expect(controllers.map(reply => reply.statusCode).sort()).toEqual([200, 403]);
    const response = controllers.find(reply => reply.statusCode === 200)!; expect({ status: response.statusCode, paused, events: (await history(fixture.nats.store, 'computer-assistant', 'test')).map(r => r.event.type) }).toMatchObject({ status: 200 }); expect(paused).toBe(true);
    const admission = response.json<{ ticket: string; leaseId: string }>();
    expect(typeof admission.ticket).toBe('string'); expect(typeof admission.leaseId).toBe('string');
    expect((await request('alice')).statusCode).toBe(403);
    expect((await history(fixture.nats.store, 'computer-assistant', 'test')).map(row => row.event.type)).toEqual(['computer.claimed', 'computer.ready', 'takeover.requested', 'takeover.started']);
  } finally { await fixture.close(); }
}, 30000);

it('refuses pause failure and records explicit release for the quiescence reaction', async () => {
  const fixture = await viewFixture(() => { throw new Error('No writer'); }, undefined, () => Promise.reject(new Error('Tool still running')));
  try {
    fixture.keys.provision('test', 'chat');
    await fixture.append('conversation-chat', 'message.posted', { conversationId: 'chat', authorId: 'alice', authorKind: 'human', contentType: 'text', ...fixture.keys.encrypt('test', 'chat', 'Login') });
    await fixture.append(grantStream('shared_desktop', 'desktop'), 'grant.given', { resourceType: 'shared_desktop', resourceId: 'desktop', granteeId: 'alice', granteeKind: 'member', grantedBy: 'owner' }, true);
    const headers = { origin: new URL(fixture.config.redirectUri).origin, 'x-opencrane-view': '1', cookie: `${fixture.config.cookieName}=${encodeSession(fixture.config, { sub: 'alice', orgId: 'org-test', roles: [], authTime: 1, exp: Math.floor(Date.now()/1000)+300 })}` };
    expect((await fixture.app.inject({ method: 'POST', url: '/api/conversations/chat/control', headers })).statusCode).toBe(403);
    const events = await history(fixture.nats.store, 'computer-assistant', 'test');
    expect(events.at(-1)?.event.type).toBe('takeover.failed');
    const status = await fixture.app.inject({ method: 'GET', url: '/api/conversations/chat/control', headers });
    expect(status.json<{ status: string; leaseId: string }>().status).toBe('paused');
    expect((await fixture.app.inject({ method: 'POST', url: '/api/conversations/chat/control', headers, payload: { action: 'release', leaseId: status.json<{ leaseId: string }>().leaseId } })).statusCode).toBe(200);
    expect((await history(fixture.nats.store, 'computer-assistant', 'test')).at(-1)?.event).toMatchObject({ type: 'takeover.ended', data: { reason: 'released' } });
  } finally { await fixture.close(); }
}, 30000);

it('admits one writer, renews it, closes its tunnel before release and keeps viewers read-only', async () => {
  const { PassThrough, Duplex } = await import('node:stream');
  const { WebSocket } = await import('ws');
  const { until } = await import('@opencrane/authz/testing');
  const forwarded: { writer: boolean; bytes: Buffer[]; stream: InstanceType<typeof Duplex> }[] = [];
  const fixture = await viewFixture((_computer, writer = false) => {
    const writable = new PassThrough(), readable = new PassThrough(), bytes: Buffer[] = [];
    writable.on('data', (chunk: Buffer) => bytes.push(chunk));
    const stream = Duplex.from({ readable, writable }); forwarded.push({ writer, bytes, stream }); return Promise.resolve(stream);
  }, undefined, async () => {});
  const sockets: InstanceType<typeof WebSocket>[] = [];
  try {
    fixture.keys.provision('test', 'chat');
    await fixture.append('conversation-chat', 'message.posted', { conversationId: 'chat', authorId: 'alice', authorKind: 'human', contentType: 'text', ...fixture.keys.encrypt('test', 'chat', 'Login') });
    await fixture.append(grantStream('shared_desktop', 'desktop'), 'grant.given', { resourceType: 'shared_desktop', resourceId: 'desktop', granteeId: 'alice', granteeKind: 'member', grantedBy: 'owner' }, true);
    const headers = { origin: new URL(fixture.config.redirectUri).origin, 'x-opencrane-view': '1', cookie: `${fixture.config.cookieName}=${encodeSession(fixture.config, { sub: 'alice', orgId: 'org-test', roles: [], authTime: 1, exp: Math.floor(Date.now()/1000)+300 })}` };
    const post = (action: string, leaseId?: string) => fixture.app.inject({ method: 'POST', url: '/api/conversations/chat/control', headers, payload: { action, ...(leaseId ? { leaseId } : {}) } });
    const address = await fixture.app.listen({ host: '127.0.0.1', port: 0 });
    const result = await post('start'); expect(result.statusCode).toBe(200);
    const { ticket, leaseId } = result.json<{ ticket: string; leaseId: string }>();
    const writer = new WebSocket(`${address.replace('http:', 'ws:')}/ws/conversations/chat/control`, ['binary', ticket], { headers }); sockets.push(writer);
    writer.on('error', () => undefined); await once(writer, 'open');
    const input = Buffer.from([4, 1, 0, 0, 0, 0, 0, 65]);
    writer.send(Buffer.concat([Buffer.from('RFB 003.008\n'), Buffer.from([1, 1]), input]));
    await until(() => Buffer.concat(forwarded[0]!.bytes).includes(input));
    expect((await post('renew', leaseId)).statusCode).toBe(200);
    expect((await post('start')).statusCode).toBe(403);
    const reuse = new WebSocket(`${address.replace('http:', 'ws:')}/ws/conversations/chat/control`, ['binary', ticket], { headers }); sockets.push(reuse); reuse.on('error', () => undefined);
    expect(await new Promise<number | undefined>(resolve => reuse.on('unexpected-response', (_req, res) => { resolve(res.statusCode); reuse.terminate(); }))).toBe(403);
    const view = await fixture.app.inject({ method: 'POST', url: '/api/conversations/chat/view', headers });
    const viewer = new WebSocket(`${address.replace('http:', 'ws:')}/ws/conversations/chat/view`, ['binary', view.json<{ ticket: string }>().ticket], { headers }); sockets.push(viewer); viewer.on('error', () => undefined); await once(viewer, 'open');
    const refused = once(viewer, 'close'); viewer.send(Buffer.concat([Buffer.from('RFB 003.008\n'), Buffer.from([1, 1]), input])); await refused;
    expect(Buffer.concat(forwarded[1]!.bytes)).toEqual(Buffer.concat([Buffer.from('RFB 003.008\n'), Buffer.from([1, 1])]));
    const closed = once(writer, 'close'); expect((await post('release', leaseId)).statusCode).toBe(200); await closed;
    expect(forwarded[0]?.stream.destroyed).toBe(true);
    const audit = await history(fixture.nats.store, 'computer-assistant', 'test');
    expect(audit.map(r => r.event.type).slice(-4)).toEqual(['takeover.requested', 'takeover.started', 'takeover.renewed', 'takeover.ended']);
    expect(audit.at(-1)?.event.data).toMatchObject({ requestedBy: 'alice', reason: 'released', leaseId, generation: 1 });
  } finally { for (const socket of sockets) socket.terminate(); await fixture.close(); }
}, 60000);

it.each(['takeover.requested', 'takeover.started', 'takeover.renewed'])('recovers a proxy crash after %s with no writer and a durable paused reason', async type => {
  const { getEventDefinition, computerWorkPaused } = await import('@opencrane/events');
  let pauses = 0;
  const fixture = await viewFixture(() => { throw new Error('No recovered writer'); }, undefined, () => { pauses++; return Promise.resolve(); });
  try {
    const sample = z.record(z.string(), z.unknown()).parse(getEventDefinition(type)!.example);
    await fixture.append('computer-assistant', type, { ...sample, assistantId: 'assistant', computerId: 'desktop', requestedBy: 'alice', conversationId: 'chat' });
    await fixture.app.ready();
    const rows = await history(fixture.nats.store, 'computer-assistant', 'test');
    expect(pauses).toBe(1);
    expect(rows.at(-1)?.event.type).toBe('takeover.ended');
    expect(rows.at(-1)?.event.data).toMatchObject({ reason: 'crash' });
    expect(computerWorkPaused(rows.map(r => r.event))).toBe(true);
  } finally { await fixture.close(); }
}, 30000);

it('closes a delayed writer connection before release and refuses input after disconnect', async () => {
  const { PassThrough, Duplex } = await import('node:stream');
  const { WebSocket } = await import('ws'); const { until } = await import('@opencrane/authz/testing');
  let resolveOpen!: (stream: InstanceType<typeof Duplex>) => void, opening = false;
  const delayed = new Promise<InstanceType<typeof Duplex>>(resolve => { resolveOpen = resolve; });
  const fixture = await viewFixture(() => { opening = true; return delayed; }, undefined, () => Promise.resolve());
  let socket: InstanceType<typeof WebSocket> | undefined;
  try {
    fixture.keys.provision('test', 'chat');
    await fixture.append('conversation-chat', 'message.posted', { conversationId: 'chat', authorId: 'alice', authorKind: 'human', contentType: 'text', ...fixture.keys.encrypt('test', 'chat', 'Login') });
    await fixture.append(grantStream('shared_desktop', 'desktop'), 'grant.given', { resourceType: 'shared_desktop', resourceId: 'desktop', granteeId: 'alice', granteeKind: 'member', grantedBy: 'owner' }, true);
    const headers = { origin: new URL(fixture.config.redirectUri).origin, 'x-opencrane-view': '1', cookie: `${fixture.config.cookieName}=${encodeSession(fixture.config, { sub: 'alice', orgId: 'org-test', roles: [], authTime: 1, exp: Math.floor(Date.now()/1000)+300 })}` };
    const address = await fixture.app.listen({ host: '127.0.0.1', port: 0 });
    const lease = (await fixture.app.inject({ method: 'POST', url: '/api/conversations/chat/control', headers })).json<{ leaseId: string; ticket: string }>();
    socket = new WebSocket(`${address.replace('http:', 'ws:')}/ws/conversations/chat/control`, ['binary', lease.ticket], { headers }); socket.on('error', () => undefined);
    await until(() => opening);
    const result = await fixture.app.inject({ method: 'POST', url: '/api/conversations/chat/control', headers, payload: { action: 'release', leaseId: lease.leaseId } });
    expect(result.statusCode).toBe(200);
    const writable = new PassThrough(); writable.resume(); const stream = Duplex.from({ readable: new PassThrough(), writable }); resolveOpen(stream);
    await until(() => stream.destroyed);
    expect((await history(fixture.nats.store, 'computer-assistant', 'test')).at(-1)?.event.data).toMatchObject({ reason: 'released' });
  } finally { socket?.terminate(); await fixture.close(); }
}, 60000);

it('closes changed requester control and lets the newly authorised requester explicitly recover', async () => {
  const { takeover } = await import('../src/computers/takeover.ts');
  const fixture = await viewFixture(() => { throw new Error('No tunnel'); }, undefined, async () => {});
  const engine = takeover({ ...fixture.chat, feed: { memberId: () => Promise.resolve('alice') }, open: () => Promise.reject(new Error('No tunnel')), control: async () => {} });
  try {
    fixture.keys.provision('test', 'chat');
    for (const member of ['alice', 'bob']) await fixture.append(grantStream('shared_desktop', 'desktop'), 'grant.given', { resourceType: 'shared_desktop', resourceId: 'desktop', granteeId: member, granteeKind: 'member', grantedBy: 'owner' }, true);
    await fixture.append('conversation-chat', 'participant.added', { conversationId: 'chat', participantId: 'bob', addedBy: 'alice' }, true);
    const post = (authorId: string) => fixture.append('conversation-chat', 'message.posted', { conversationId: 'chat', authorId, authorKind: 'human', contentType: 'text', ...fixture.keys.encrypt('test', 'chat', 'Login') });
    await post('alice');
    const lease = await engine.start('alice', 'chat', Date.now() + 300000);
    await post('bob'); await engine.reconcile();
    await expect(engine.release('alice', 'chat', lease.leaseId)).rejects.toThrow('requester');
    expect(await engine.status('bob', 'chat')).toMatchObject({ status: 'paused', leaseId: lease.leaseId });
    await engine.release('bob', 'chat', lease.leaseId);
    expect((await history(fixture.nats.store, 'computer-assistant', 'test')).at(-1)?.event).toMatchObject({ principal: { id: 'bob' }, data: { reason: 'released', endedBy: 'bob', requestedBy: 'alice' } });
  } finally { await engine.close(); await fixture.close(); }
}, 30000);

it.each(['takeover.requested', 'takeover.started', 'takeover.renewed', 'takeover.ended'])('grants no unaudited transition when %s persistence fails', async fault => {
  const { vi } = await import('vitest'); const { takeover } = await import('../src/computers/takeover.ts');
  let pauses = 0;
  const fixture = await viewFixture(() => { throw new Error('No tunnel'); });
  const engine = takeover({ ...fixture.chat, open: () => Promise.reject(new Error('No tunnel')), control: () => { pauses++; return Promise.resolve(); } });
  try {
    fixture.keys.provision('test', 'chat');
    await fixture.append('conversation-chat', 'message.posted', { conversationId: 'chat', authorId: 'alice', authorKind: 'human', contentType: 'text', ...fixture.keys.encrypt('test', 'chat', 'Login') });
    await fixture.append(grantStream('shared_desktop', 'desktop'), 'grant.given', { resourceType: 'shared_desktop', resourceId: 'desktop', granteeId: 'alice', granteeKind: 'member', grantedBy: 'owner' }, true);
    const append = fixture.nats.store.append.bind(fixture.nats.store);
    const failing = vi.spyOn(fixture.nats.store, 'append').mockImplementation(command => z.object({ type: z.string() }).parse(command.event).type === fault ? Promise.reject(new Error('Audit unavailable')) : append(command));
    if (['takeover.requested', 'takeover.started'].includes(fault)) {
      await expect(engine.start('alice', 'chat', Date.now() + 300000)).rejects.toThrow();
      expect((await history(fixture.nats.store, 'computer-assistant', 'test')).some(r => r.event.type === 'takeover.started')).toBe(false);
      expect(pauses).toBe(fault === 'takeover.requested' ? 0 : 1);
    } else {
      const lease = await engine.start('alice', 'chat', Date.now() + 300000);
      if (fault === 'takeover.renewed') await expect(engine.renew('alice', 'chat', lease.leaseId, Date.now() + 300000)).rejects.toThrow();
      else {
        let closed = false; engine.connect(lease.leaseId, () => { closed = true; });
        const beforeRelease = pauses;
        await expect(engine.release('alice', 'chat', lease.leaseId)).rejects.toThrow(); expect(closed).toBe(true);
        expect(pauses).toBe(beforeRelease);
        await expect(engine.check('alice', 'chat', lease.leaseId)).rejects.toThrow();
        failing.mockRestore(); await engine.release('alice', 'chat', lease.leaseId);
      }
    }
  } finally { vi.restoreAllMocks(); await engine.close(); await fixture.close(); }
}, 30000);

it.each(['expired', 'access_changed', 'disconnected'] as const)('ends %s control and requires an explicit release before new work', async reason => {
  const { takeover } = await import('../src/computers/takeover.ts'); const { until } = await import('@opencrane/authz/testing');
  const fixture = await viewFixture(() => { throw new Error('No tunnel'); });
  const engine = takeover({ ...fixture.chat, open: () => Promise.reject(new Error('No tunnel')), control: async () => {} });
  try {
    fixture.keys.provision('test', 'chat');
    await fixture.append('conversation-chat', 'message.posted', { conversationId: 'chat', authorId: 'alice', authorKind: 'human', contentType: 'text', ...fixture.keys.encrypt('test', 'chat', 'Login') });
    const grant = { resourceType: 'shared_desktop', resourceId: 'desktop', granteeId: 'alice', granteeKind: 'member', grantedBy: 'owner' };
    await fixture.append(grantStream('shared_desktop', 'desktop'), 'grant.given', grant, true);
    const lease = await engine.start('alice', 'chat', Date.now() + (reason === 'expired' ? 1000 : 300000));
    let closed = false; engine.connect(lease.leaseId, () => { closed = true; });
    if (reason === 'expired') await until(() => Date.now() >= Date.parse(lease.expiresAt));
    if (reason === 'access_changed') await fixture.append(grantStream('shared_desktop', 'desktop'), 'grant.revoked', { resourceType: 'shared_desktop', resourceId: 'desktop', granteeId: 'alice', revokedBy: 'owner' }, true);
    if (reason === 'disconnected') await engine.stop(lease.leaseId, reason); else await engine.reconcile();
    expect(closed).toBe(true);
    expect((await history(fixture.nats.store, 'computer-assistant', 'test')).at(-1)?.event.data).toMatchObject({ reason });
    await expect(engine.renew('alice', 'chat', lease.leaseId, Date.now() + 300000)).rejects.toThrow();
    await expect(engine.start('alice', 'chat', Date.now() + 300000)).rejects.toThrow();
    if (reason === 'access_changed') await fixture.append(grantStream('shared_desktop', 'desktop'), 'grant.given', grant, true);
    await engine.release('alice', 'chat', lease.leaseId);
    expect((await engine.status('alice', 'chat')).status).toBe('ready');
  } finally { await engine.close(); await fixture.close(); }
}, 30000);

it('releases a failed pause with missing terminal reports into one fresh checked message', async () => {
  const { takeover } = await import('../src/computers/takeover.ts'); const { resumeAfterRelease } = await import('../src/chat/release.ts'); const { memberAuthorisation } = await import('@opencrane/authz');
  const fixture = await viewFixture(() => Promise.reject(new Error('No tunnel')));
  let failPause = true;
  const engine = takeover({ ...fixture.chat, open: () => Promise.reject(new Error('No tunnel')), control: () => failPause ? Promise.reject(new Error('Interrupt unavailable')) : Promise.resolve() });
  try {
    fixture.keys.provision('test', 'chat');
    const message = await fixture.append('conversation-chat', 'message.posted', { conversationId: 'chat', authorId: 'alice', authorKind: 'human', contentType: 'text', ...fixture.keys.encrypt('test', 'chat', 'Login') });
    await fixture.append('computer-assistant', 'computer.turn_started', { assistantId: 'assistant', computerId: 'desktop', conversationId: 'chat', turnId: message.id, threadId: 'thread', requesterId: 'alice', task: 'chat_turn' });
    await fixture.append(grantStream('shared_desktop', 'desktop'), 'grant.given', { resourceType: 'shared_desktop', resourceId: 'desktop', granteeId: 'alice', granteeKind: 'member', grantedBy: 'owner' }, true);
    await expect(engine.start('alice', 'chat', Date.now() + 300000)).rejects.toThrow();
    const status = await engine.status('alice', 'chat'); failPause = false;
    await engine.release('alice', 'chat', status.leaseId!);
    const end = (await history(fixture.nats.store, 'computer-assistant', 'test')).at(-1)!.event;
    for (let retry = 0; retry < 2; retry++) await resumeAfterRelease(fixture.chat, end, memberAuthorisation(fixture.binding));
    expect((await history(fixture.nats.store, 'computer-assistant', 'test')).at(-1)?.event).toMatchObject({ type: 'computer.turn_closed', data: { turnId: message.id, status: 'failed' } });
    const messages = (await history(fixture.nats.store, 'conversation-chat', 'test')).filter(r => r.event.type === 'message.posted');
    expect(messages).toHaveLength(2); expect(messages[1]!.event.id).not.toBe(message.id);
    expect(fixture.keys.decrypt('test', 'chat', messages[1]!.event.data)).toContain('keep unknown outcomes uncertain');
  } finally { await engine.close(); await fixture.close(); }
}, 30000);

it('a rejected release retry leaves the released computer running', async () => {
  const { takeover } = await import('../src/computers/takeover.ts');
  let paused = false;
  const fixture = await viewFixture(() => Promise.reject(new Error('No tunnel')));
  const engine = takeover({ ...fixture.chat, open: () => Promise.reject(new Error('No tunnel')),
    control: (_computer, action) => { paused = action === 'pause'; return Promise.resolve(); } });
  try {
    fixture.keys.provision('test', 'chat');
    await fixture.append('conversation-chat', 'message.posted', { conversationId: 'chat', authorId: 'alice', authorKind: 'human', contentType: 'text', ...fixture.keys.encrypt('test', 'chat', 'Login') });
    await fixture.append(grantStream('shared_desktop', 'desktop'), 'grant.given', { resourceType: 'shared_desktop', resourceId: 'desktop', granteeId: 'alice', granteeKind: 'member', grantedBy: 'owner' }, true);
    expect(paused).toBe(false);
    const lease = await engine.start('alice', 'chat', Date.now() + 300000);
    await engine.release('alice', 'chat', lease.leaseId);
    // The release reaction has resumed execution before the retry arrives.
    paused = false;
    const released = await history(fixture.nats.store, 'computer-assistant', 'test');
    await expect(engine.release('alice', 'chat', lease.leaseId)).rejects.toThrow('Already released');
    expect(await engine.status('alice', 'chat')).toEqual({ status: 'ready' });
    expect(await history(fixture.nats.store, 'computer-assistant', 'test')).toEqual(released);
    expect(paused).toBe(false);
  } finally { await engine.close(); await fixture.close(); }
}, 30000);

it('a delayed losing takeover cannot pause execution after the winner releases', async () => {
  const { takeover } = await import('../src/computers/takeover.ts');
  let paused = false, winner: string | undefined, arrived!: () => void, deliver!: () => void;
  const arriving = new Promise<void>(resolve => { arrived = resolve; });
  const delayed = new Promise<void>(resolve => { deliver = resolve; });
  const fixture = await viewFixture(() => Promise.reject(new Error('No tunnel')));
  const engine = takeover({ ...fixture.chat, open: () => Promise.reject(new Error('No tunnel')),
    control: async (_computer, action, leaseId) => {
      if (action === 'pause' && winner && leaseId !== winner) { arrived(); await delayed; }
      paused = action === 'pause';
    } });
  try {
    fixture.keys.provision('test', 'chat');
    await fixture.append('conversation-chat', 'message.posted', { conversationId: 'chat', authorId: 'alice', authorKind: 'human', contentType: 'text', ...fixture.keys.encrypt('test', 'chat', 'Login') });
    await fixture.append(grantStream('shared_desktop', 'desktop'), 'grant.given', { resourceType: 'shared_desktop', resourceId: 'desktop', granteeId: 'alice', granteeKind: 'member', grantedBy: 'owner' }, true);
    expect(paused).toBe(false);
    const lease = await engine.start('alice', 'chat', Date.now() + 300000); winner = lease.leaseId;
    const losing = engine.start('alice', 'chat', Date.now() + 300000).then(() => 'admitted', () => 'refused');
    await Promise.race([arriving, losing]);
    await engine.release('alice', 'chat', lease.leaseId);
    paused = false; // The committed release reaction has resumed execution.
    deliver(); expect(await losing).toBe('refused');
    expect(await engine.status('alice', 'chat')).toEqual({ status: 'ready' });
    expect((await history(fixture.nats.store, 'computer-assistant', 'test')).at(-1)?.event.data).toMatchObject({ reason: 'released', leaseId: winner });
    expect(paused).toBe(false);
  } finally { deliver(); await engine.close(); await fixture.close(); }
}, 30000);
