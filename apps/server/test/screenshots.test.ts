import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { fileUploadedDataSchema } from '@opencrane/events';
import { PassThrough, Duplex } from 'node:stream';
import { expect, it } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { grantStream } from '@opencrane/authz';
import { files, conversations } from '@opencrane/projections';
import { history } from '@opencrane/models';
import { buildServer } from '../src/server.ts';
import { viewFixture } from './support/view-fixture.ts';
import { uploadServices } from './support/upload-services.ts';

// Record desktop traffic through the authenticated connection and use known red pixels.
function desktop(width = 2, height = 2) {
  const readable = new PassThrough(), writable = new PassThrough();
  let stage = 0;
  writable.on('data', () => {
    stage++;
    if (stage === 1) readable.write(Buffer.from([1, 1]));
    if (stage === 2) readable.write(Buffer.alloc(4));
    if (stage === 3) {
      const init = Buffer.alloc(24); init.writeUInt16BE(width); init.writeUInt16BE(height, 2); init[4] = 32;
      readable.write(init);
    }
    if (stage === 6) {
      const rectangle = Buffer.alloc(16); rectangle.writeUInt16BE(1, 2); rectangle.writeUInt16BE(2, 8); rectangle.writeUInt16BE(2, 10);
      readable.write(Buffer.concat([rectangle, Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0])]));
    }
  });
  readable.write(Buffer.from('RFB 003.008\n'));
  return Promise.resolve(Duplex.from({ readable, writable }));
}

it('captures once, scans and stores a PNG whose file and preview survive replay', async () => {
  const fixture = await viewFixture(() => desktop()), services = await uploadServices();
  const { config, runner, nats, binding, feed, db, keys } = fixture;
  const options = { silo: 'test', store: nats.store, binding, feed, db, keys };
  const app = buildServer(config, { chat: options, files: { ...options, ...services }, liveView: { ...options, open: () => desktop() } });
  const headers = { origin: new URL(config.redirectUri).origin, 'x-opencrane-view': '1', 'idempotency-key': 'capture',
    cookie: `${config.cookieName}=${encodeSession(config, { sub: 'alice', orgId: 'org-test', roles: [], authTime: 1, exp: Math.floor(Date.now()/1000)+300 })}` };
  const url = '/api/conversations/chat/screenshots';
  try {
    await fixture.append(grantStream('shared_desktop', 'desktop'), 'grant.given', { resourceType: 'shared_desktop', resourceId: 'desktop', granteeId: 'alice', granteeKind: 'member', grantedBy: 'owner' }, true);
    const replies = await Promise.all(Array.from({ length: 3 }, () => app.inject({ method: 'POST', url, headers })));
    const result = replies[0]!;
    expect(replies.map(reply => reply.statusCode)).toEqual([201, 201, 201]);
    expect(replies.map(reply => reply.json<unknown>())).toEqual([result.json(), result.json(), result.json()]);
    expect(result.statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', url, headers })).json()).toEqual(result.json());
    const rows = await history(nats.store, 'conversation-chat', 'test');
    expect(rows.filter(row => row.event.type === 'file.uploaded')).toHaveLength(1);
    expect(rows.at(-1)?.event.data).toMatchObject({ mime: 'image/png', uploadedBy: 'alice', screenshot: { computerId: 'desktop', generation: 1, width: 2, height: 2 } });
    await runner.initialise(files); await runner.run(files); await runner.run(conversations);
    const list = await app.inject({ url: '/api/conversations/chat/files', headers });
    const path = list.json<{ rows: { path: string }[] }>().rows[0]!.path;
    const preview = `/api/conversations/chat/files/view?path=${encodeURIComponent(path)}&preview=true`;
    const image = await app.inject({ url: preview, headers });
    expect(image.statusCode).toBe(200); expect(image.headers['content-type']).toContain('image/png');
    expect(image.rawPayload.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    const saved = fileUploadedDataSchema.parse(rows.at(-1)?.event.data);
    expect(createHash('sha256').update(image.rawPayload).digest('hex')).toBe(saved.sha256);
    expect(Number.isNaN(Date.parse(saved.screenshot!.capturedAt))).toBe(false);
    const compressedSize = image.rawPayload.readUInt32BE(33);
    expect([...inflateSync(image.rawPayload.subarray(41, 41 + compressedSize))]).toEqual([0, 255, 0, 0, 255, 0, 0, 0, 255, 0, 0, 255, 0, 0]);
    await runner.rebuild(files); await runner.rebuild(conversations);
    expect((await app.inject({ url: '/api/conversations/chat/files', headers })).json()).toEqual(list.json());
    expect((await app.inject({ url: preview, headers })).rawPayload).toEqual(image.rawPayload);
    expect((await app.inject({ url: '/api/conversations/chat/messages', headers })).body).toContain('file.uploaded');
    const bob = { ...headers, cookie: `${config.cookieName}=${encodeSession(config, { sub: 'bob', orgId: 'org-test', roles: [], authTime: 1, exp: Math.floor(Date.now()/1000)+300 })}` };
    expect((await app.inject({ url: preview, headers: bob })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url, headers: bob })).statusCode).toBe(403);
    await fixture.append('participation-chat', 'participant.added', { conversationId: 'chat', participantId: 'bob', addedBy: 'alice' }, true);
    await runner.run(conversations);
    expect((await app.inject({ url: preview, headers: bob })).statusCode).toBe(403);
    const oldDownload = preview.replace('&preview=true', '');
    expect((await app.inject({ url: oldDownload, headers: bob })).statusCode).toBe(403);
    await fixture.append(grantStream('shared_desktop', 'desktop'), 'grant.given', { resourceType: 'shared_desktop', resourceId: 'desktop', granteeId: 'bob', granteeKind: 'member', grantedBy: 'owner' }, true);
    const laterHeaders = { ...bob, 'idempotency-key': 'post-join-capture' };
    const laterCapture = await app.inject({ method: 'POST', url, headers: laterHeaders });
    expect(laterCapture.statusCode, laterCapture.body).toBe(201);
    await runner.run(files);
    await runner.run(conversations);
    const laterList = await app.inject({ url: '/api/conversations/chat/files', headers: bob });
    const laterRows = laterList.json<{ rows: { path: string }[] }>().rows;
    expect(laterRows).toHaveLength(1);
    const laterDownload = `/api/conversations/chat/files/view?path=${encodeURIComponent(laterRows[0]!.path)}`;
    expect((await app.inject({ url: laterDownload, headers: bob })).statusCode).toBe(200);
    expect((await app.inject({ url: `${laterDownload}&preview=true`, headers: bob })).statusCode)
      .toBe(200);
    await fixture.append('participation-chat', 'participant.removed', { conversationId: 'chat', participantId: 'bob', removedBy: 'alice' });
    expect((await app.inject({ url: preview, headers: bob })).statusCode).toBe(403);
    const download = preview.replace('&preview=true', '');
    const foreign = `${config.cookieName}=${encodeSession(config, { sub: 'alice', orgId: 'foreign', roles: [], authTime: 1, exp: Math.floor(Date.now()/1000)+300 })}`;
    expect((await app.inject({ url: download, headers: { ...headers, cookie: foreign } })).statusCode).toBe(403);
    const expired = `${config.cookieName}=${encodeSession(config, { sub: 'alice', orgId: 'org-test', roles: [], authTime: 1, exp: 1 })}`;
    expect((await app.inject({ url: download, headers: { ...headers, cookie: expired } })).statusCode).toBe(401);
    expect((await app.inject({ url: download })).statusCode).toBe(401);
    await fixture.append('member-alice', 'member.removed', { memberId: 'alice', removedBy: 'owner' });
    expect((await app.inject({ url: preview, headers })).statusCode).toBe(403);
    expect((await app.inject({ url: download, headers })).statusCode).toBe(403);


  } finally { await app.close(); await fixture.close(); await services.close(); }
}, 180_000);

it('refuses stale authority, arbitrary capture input, failed scans and oversized desktops without publishing a file', async () => {
  const fixture = await viewFixture(() => desktop()), services = await uploadServices();
  const { config, nats, binding, feed, db, keys } = fixture;
  const options = { silo: 'test', store: nats.store, binding, feed, db, keys };
  const fileOptions = { ...options, objects: services.objects, scan: services.scan };
  const view = { ...options, open: () => desktop() };
  const app = buildServer(config, { files: fileOptions, liveView: view });
  const cookie = (sub = 'alice', orgId = 'org-test', exp = Math.floor(Date.now()/1000)+300) => `${config.cookieName}=${encodeSession(config, { sub, orgId, roles: [], authTime: 1, exp })}`;
  const headers = { origin: new URL(config.redirectUri).origin, cookie: cookie(), 'x-opencrane-view': '1', 'idempotency-key': 'failure' };
  const request = (custom = {}, payload?: object) => app.inject({ method: 'POST', url: '/api/conversations/chat/screenshots', headers: { ...headers, ...custom }, ...(payload ? { payload } : {}) });
  const grant = { resourceType: 'shared_desktop', resourceId: 'desktop', granteeId: 'alice', granteeKind: 'member', grantedBy: 'owner' };
  try {
    expect((await request()).statusCode).toBe(403);
    await fixture.append(grantStream('shared_desktop', 'desktop'), 'grant.given', grant, true);
    for (const custom of [{ cookie: '' }, { cookie: cookie('alice', 'org-test', 1) }]) expect((await request(custom)).statusCode).toBe(401);
    for (const custom of [{ cookie: cookie('alice', 'foreign') }, { cookie: cookie('bob') }, { origin: 'https://foreign.test' }, { 'x-opencrane-view': '0' }]) expect((await request(custom)).statusCode).toBe(403);
    expect((await request({}, { url: 'http://metadata/', path: '/tmp/image.png' })).statusCode).toBe(400);
    view.open = () => desktop(4096, 4096);
    expect((await request()).statusCode).toBe(503);
    view.open = () => desktop();
    fileOptions.scan = () => Promise.reject(new Error('Scanner unavailable'));
    expect((await request()).statusCode).toBe(503);
    fileOptions.scan = async () => {
      await fixture.append(grantStream('shared_desktop', 'desktop'), 'grant.revoked', { resourceType: 'shared_desktop', resourceId: 'desktop', granteeId: 'alice', revokedBy: 'owner' });
      return 'clean';
    };
    expect((await request()).statusCode).toBe(403);
    await fixture.append(grantStream('shared_desktop', 'desktop'), 'grant.given', grant, true);
    fileOptions.scan = async () => {
      await fixture.append('computer-assistant', 'computer.claimed', { assistantId: 'assistant', computerId: 'desktop', generation: 2, sandboxUid: 'next', tokenId: 'token:next' });
      await fixture.append('computer-assistant', 'computer.ready', { assistantId: 'assistant', computerId: 'desktop', generation: 2, podUid: 'next' });
      return 'clean';
    };
    expect((await request()).statusCode).toBe(403);
    expect((await history(nats.store, 'conversation-chat', 'test')).filter(row => row.event.type === 'file.uploaded')).toHaveLength(0);
    expect(await services.client.listObjectsV2('files', '', true).toArray()).toEqual([]);
    fileOptions.scan = () => Promise.resolve('infected');
    expect((await request()).statusCode).toBe(422);
    expect((await request()).statusCode).toBe(422);
    expect((await history(nats.store, 'conversation-chat', 'test')).filter(row => row.event.type === 'file.rejected')).toHaveLength(1);
    expect(await services.client.listObjectsV2('files', '', true).toArray()).toEqual([]);
  } finally { await app.close(); await fixture.close(); await services.close(); }
}, 180_000);

// Use the screenshot probe to refuse a shared session before opening its desktop.
async function refusesTeamScreenshotBeforeCapture() {
  let captures = 0;
  function open() {
    captures++;
    return desktop();
  }
  const fixture = await viewFixture(open);
  const services = await uploadServices();
  const { config, nats, binding, feed, db, keys } = fixture;
  const options = { silo: 'test', store: nats.store, binding, feed, db, keys };
  const files = { ...options, ...services };
  const view = { ...options, open };
  const app = buildServer(config, { files, liveView: view });
  try {
    await fixture.append('team-sales', 'team.created', {
      teamId: 'sales', name: 'Sales', createdBy: 'alice',
    }, true);
    await fixture.append('team-sales', 'team.member_added', {
      teamId: 'sales', memberId: 'alice', addedBy: 'alice',
    }, true);
    await fixture.append('assistant-team-sales', 'assistant.created', {
      assistantId: 'team-sales', ownerId: 'sales', kind: 'team', payingGroupId: 'sales',
    }, true);
    await fixture.append('computer-team-sales', 'computer.claimed', {
      assistantId: 'team-sales', computerId: 'team-desktop', generation: 1, tokenId: 'token:test',
    });
    await fixture.append('computer-team-sales', 'computer.ready', {
      assistantId: 'team-sales', computerId: 'team-desktop', generation: 1, podUid: 'pod',
    });
    await fixture.append('conversation-team-session', 'conversation.created', {
      conversationId: 'team-session', assistantId: 'team-sales', createdBy: 'alice',
      mode: 'agent_session', payingGroupId: 'sales',
    }, true);
    await fixture.append(grantStream('shared_desktop', 'team-desktop'), 'grant.given', {
      resourceType: 'shared_desktop', resourceId: 'team-desktop', granteeId: 'alice',
      granteeKind: 'member', grantedBy: 'alice',
    }, true);
    const session = { sub: 'alice', orgId: 'org-test', roles: [], authTime: 1,
      exp: Math.floor(Date.now() / 1000) + 300 };
    const headers = { origin: new URL(config.redirectUri).origin, 'x-opencrane-view': '1',
      'idempotency-key': 'team-shot',
      cookie: `${config.cookieName}=${encodeSession(config, session)}` };
    const response = await app.inject({ method: 'POST',
      url: '/api/conversations/team-session/screenshots', headers });
    expect(response.statusCode, response.body).toBe(403);
    expect(captures).toBe(0);
    expect(response.body).toContain('share one workspace');
  } finally {
    await app.close();
    await fixture.close();
    await services.close();
  }
}
it('refuses a team screenshot before capturing the shared desktop',
  refusesTeamScreenshotBeforeCapture, 120_000);
