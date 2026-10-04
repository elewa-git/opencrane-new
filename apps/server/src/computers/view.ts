import { takeover } from './takeover.ts';
import { z } from 'zod';
import { viewerStream, desktopStream } from './rfb.ts';
import type { IncomingHttpHeaders } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { FastifyInstance } from 'fastify';
import { decodeSession, isIdentityAllowed, parseCookieHeader, type AuthConfig } from '@opencrane/auth';
import { envelope } from '@opencrane/models';
import { viewAccess, type LiveViewOptions } from './view-access.ts';

export type { LiveViewOptions } from './view-access.ts';
type Ticket = { cookie: string; memberId: string; conversationId: string; sessionId: string; expires: number; redeemBy: number; leaseId?: string };
type StopReason = 'disconnected' | 'access_changed' | 'expired' | 'protocol' | 'slow_viewer' | 'upstream' | 'shutdown';
const admissionPath = /^\/api\/conversations\/([\w-]{1,200})\/view$/u;
export const liveViewPath = /^\/ws\/conversations\/([\w-]{1,200})\/(?:view|control)$/u;
function deadline<T>(work: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    // Include event reads around OpenFGA's one-second call; the desktop lease remains 1.5 seconds.
    const timer = setTimeout(() => reject(new Error('View check timeout')), 1200);
    void work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

export function registerLiveView(app: FastifyInstance, config: AuthConfig, options?: LiveViewOptions) {
  const controls = options && takeover(options);
  let opening = 0;
  const tickets = new Map<string, Ticket>();
  const stops = new Set<(reason: StopReason) => void>();
  const audits = new Set<Promise<void>>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false, autoPong: false,
    handleProtocols: () => 'binary' });
  const origin = new URL(config.redirectUri).origin;
  function authenticate(headers: IncomingHttpHeaders) {
    if (headers.origin !== origin || !config.expectedOrgId) throw new Error('Wrong origin');
    const cookie = parseCookieHeader(headers.cookie)[config.cookieName];
    if (!cookie) throw new Error('No session');
    const session = decodeSession(config, cookie);
    if (session.orgId !== config.expectedOrgId || !isIdentityAllowed(config, { issuer: config.issuerUrl, subject: session.sub, orgId: session.orgId })) throw new Error('Wrong silo');
    return { session, cookie };
  }
  async function refusal(reason: 'admission' | 'upgrade' | 'capacity', conversationId?: string, memberId?: string) {
    const attemptId = randomUUID();
    try {
      if (!options) throw new Error('Audit unavailable');
      const event = envelope(options.silo, `view-${attemptId}`, 'computer.view_refused',
        { attemptId, reason, ...(conversationId ? { conversationId } : {}) });
      event.source = 'opencrane-server'; event.principal = memberId ? { kind: 'human', id: memberId } : { kind: 'system', id: 'anonymous-view' };
      if ((await options.store.append({ event, expectedSequence: 0 })).status !== 'appended') throw new Error('Audit unavailable');
    } catch { app.log.error({ operation: 'view.refused', attemptId, reason }, 'View refusal audit unavailable'); }
    return attemptId;
  }
  app.route({ method: ['GET', 'POST'], url: '/api/conversations/:conversationId/control', bodyLimit: 1024,
    handler: async (request, reply) => {
      reply.header('cache-control', 'no-store');
      if (!options || !controls) return reply.code(503).send({ status: 'unavailable' });
      let memberId: string | undefined;
      const conversationId = z.object({ conversationId: z.string().regex(/^[\w-]{1,200}$/u) }).parse(request.params).conversationId;
      try {
        const { session, cookie } = authenticate(request.headers);
        if (request.headers['x-opencrane-view'] !== '1') throw new Error('CSRF check failed');
        memberId = (await deadline(options.feed.memberId(options.silo, config.issuerUrl, session.sub))) ?? undefined;
        if (!memberId) throw new Error('Member required');
        if (request.method === 'GET') return await controls.status(memberId, conversationId);
        const input = z.object({ action: z.enum(['start', 'renew', 'release', 'status']).default('start'), leaseId: z.string().optional() }).strict().parse(request.body ?? {});
        if (input.action === 'status') return await controls.status(memberId, conversationId);
        if (input.action !== 'start') {
          if (!input.leaseId) throw new Error('Lease required');
          if (input.action === 'release') { await controls.release(memberId, conversationId, input.leaseId); return { status: 'ready' }; }
          const renewed = await controls.renew(memberId, conversationId, input.leaseId, session.exp * 1000);
          return { status: 'controlling', leaseId: renewed.leaseId, expiresAt: renewed.expiresAt };
        }
        if (tickets.size >= 1024 || stops.size + opening >= 16) throw new Error('Control capacity');
        const lease = await controls.start(memberId, conversationId, session.exp * 1000);
        const ticket = randomBytes(32).toString('hex'), sessionId = randomUUID();
        tickets.set(ticket, { cookie, memberId, conversationId, sessionId, leaseId: lease.leaseId,
          expires: session.exp * 1000, redeemBy: Date.now() + 15_000 });
        return { ticket, leaseId: lease.leaseId, expiresAt: lease.expiresAt };
      } catch { return reply.code(403).send({ status: 'paused_or_refused', attemptId: await refusal('admission', conversationId, memberId) }); }
    } });
  app.post('/api/conversations/:conversationId/view', { bodyLimit: 1024 }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    if (!options) return reply.code(503).send({ status: 'unavailable' });
    let memberId: string | undefined;
    const conversationId = admissionPath.exec(request.url)?.[1];
    try {
      const { session, cookie } = authenticate(request.headers);
      if (!conversationId || request.headers['x-opencrane-view'] !== '1') throw new Error('CSRF check failed');
      memberId = (await deadline(options.feed.memberId(options.silo, config.issuerUrl, session.sub))) ?? undefined;
      if (!memberId) throw new Error('Member required');
      await deadline(viewAccess(options, memberId, conversationId));
      for (const [key, value] of tickets) if (value.redeemBy <= Date.now()) tickets.delete(key);
      if (tickets.size >= 1024 || stops.size + opening >= 16) throw new Error('View capacity');
      const ticket = randomBytes(32).toString('hex'), sessionId = randomUUID();
      tickets.set(ticket, { cookie, memberId, conversationId, sessionId,
        expires: Math.min(session.exp * 1000, Date.now() + 120_000), redeemBy: Date.now() + 15_000 });
      return { ticket, sessionId };
    } catch { return reply.code(403).send({ status: 'refused', attemptId: await refusal('admission', conversationId, memberId) }); }
  });
  if (!options) { wss.close(); return; }
  async function ticketAccess(ticket: Ticket) {
    if (!options) throw new Error('View unavailable');
    return ticket.leaseId && controls ? controls.check(ticket.memberId, ticket.conversationId, ticket.leaseId) : viewAccess(options, ticket.memberId, ticket.conversationId);
  }
  function redeem(headers: IncomingHttpHeaders, conversationId: string, writer: boolean) {
      const { cookie } = authenticate(headers);
      const protocols = headers['sec-websocket-protocol']?.split(',').map(s => s.trim());
      const key = protocols?.[1] ?? '', ticket = tickets.get(key); tickets.delete(key);
      if (protocols?.[0] !== 'binary' || !ticket || ticket.cookie !== cookie || ticket.redeemBy <= Date.now() || ticket.conversationId !== conversationId || Boolean(ticket.leaseId) !== writer) throw new Error('Invalid ticket');
    return ticket;
  }
  app.server.on('upgrade', (request, socket, head) => {
    const match = liveViewPath.exec(request.url ?? '');
    if (!match) return;
    socket.on('error', () => socket.destroy());
    const refuse = () => socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    if (opening + stops.size >= 16) { void refusal('capacity', match[1]).then(refuse); return; }
    opening++; let reserved = true;
    void (async () => {
      if (!options) throw new Error('View unavailable');
      const ticket = redeem(request.headers, match[1]!, request.url?.endsWith('/control') ?? false);
      const check = () => ticketAccess(ticket);
      const allowed = await deadline(check());
      const computer = z.object({ assistantId: z.string(), computerId: z.string(), generation: z.int(), podUid: z.string().optional() }).parse(allowed);
      const sameComputer = (current: Awaited<ReturnType<typeof check>>) => current.computerId === computer.computerId && current.generation === computer.generation && current.podUid === computer.podUid;
      const expires = () => ticket.leaseId && controls ? Math.min(ticket.expires, controls.expires(ticket.leaseId)) : ticket.expires;
      const data = { ...computer, sessionId: ticket.sessionId, memberId: ticket.memberId, conversationId: ticket.conversationId, expiresAt: new Date(ticket.expires).toISOString() };
      const { podUid: _podUid, ...auditData } = data;
      const started = envelope(options.silo, `view-${ticket.sessionId}`, 'computer.view_started', auditData);
      started.source = 'opencrane-server'; started.principal = { kind: 'human', id: ticket.memberId }; started.correlation = { conversation: ticket.conversationId };
      const result = await options.store.append({ event: started, expectedSequence: 0 });
      if (result.status !== 'appended') throw new Error('Audit unavailable');
      // Include the check after the start audit in the limit of five outstanding checks.
      let viewer: WebSocket | undefined, upstream: Duplex | undefined, stopped = false, checking = 1;
      let validUntil = Date.now() + 1500, closingControl = false;
      const stop = (reason: StopReason) => {
        if (stopped) return; stopped = true; clearInterval(timer); stops.delete(stop);
        if (ticket.leaseId && controls && !closingControl) {
          const audit = controls.stop(ticket.leaseId, reason).catch(() => app.log.error({ operation: 'control.stop' }, 'Control end audit unavailable'));
          audits.add(audit); void audit.finally(() => audits.delete(audit));
        }
        upstream?.destroy();
        if (viewer) { viewer.close(reason === 'access_changed' || reason === 'expired' ? 4003 : reason === 'slow_viewer' ? 1013 : 1000, reason);
          const reap = setTimeout(() => viewer?.terminate(), 1000); reap.unref(); viewer.once('close', () => clearTimeout(reap));
        } else socket.destroy();
        const event = { ...started, id: randomUUID(), commandId: randomUUID(), type: 'computer.view_stopped', time: new Date().toISOString(), data: { ...auditData, reason } };
        const audit = options.store.append({ event, expectedSequence: result.sequence }).then(outcome => {
          if (outcome.status !== 'appended') throw new Error('View stop audit unavailable');
        }).catch(() => { app.log.error({ operation: 'view.stop', sessionId: ticket.sessionId }, 'View stop audit unavailable'); });
        audits.add(audit); void audit.finally(() => audits.delete(audit));
      };
      const timer = setInterval(() => {
        if (Date.now() >= expires()) return stop('expired');
        if (Date.now() >= validUntil) return stop('access_changed');
        // Five checks cover the 1200ms deadline without skipping a 250ms start.
        if (checking >= 5) return;
        checking++;
        const checkedAt = Date.now();
        void deadline(check()).then(current => {
          if (!sameComputer(current)) return stop('access_changed');
          // A delayed reply must not extend the age of the authority snapshot.
          validUntil = Math.max(validUntil, checkedAt + 1500);
        }, () => stop('access_changed')).finally(() => { checking--; });
      }, 250);
      if (ticket.leaseId && controls) controls.connect(ticket.leaseId, () => { closingControl = true; stop('disconnected'); });
      stops.add(stop); opening--; reserved = false; socket.once('close', () => stop('disconnected'));
      if (socket.destroyed) { stop('disconnected'); return; }
      try {
        // Audit persistence can wait long enough for authority or the cookie to expire.
        const checkedAt = Date.now();
        const current = await deadline(check()).catch(() => undefined).finally(() => { checking--; });
        if (stopped || !current || !sameComputer(current)) { stop('access_changed'); return; }
        if (Date.now() >= expires()) { stop('expired'); return; }
        validUntil = Math.max(validUntil, checkedAt + 1500);
        upstream = await options.open(computer, Boolean(ticket.leaseId));
        upstream.on('error', () => stop('upstream'));
        const connectionClosed = () => stopped || socket.destroyed || upstream!.destroyed;
        if (connectionClosed()) { upstream.destroy(); stop('upstream'); return; }
        wss.handleUpgrade(request, socket, head, ws => {
          viewer = ws;
          // bufferedAmount includes the socket queue and queued WebSocket frames.
          // Leave room for ws's automatic close reply or protocol-error frame (at most 127 bytes).
          const room = (frameBytes: number) => !stopped && ws.bufferedAmount + frameBytes + 127 <= 4 * 1024 * 1024;
          let pingWindow = Date.now(), pings = 0;
          ws.on('ping', (bytes: Buffer) => {
            if (stopped) return;
            if (Date.now() - pingWindow >= 1000) { pingWindow = Date.now(); pings = 0; }
            if (++pings > 16 || !room(bytes.length + 2)) return stop('slow_viewer');
            ws.pong(bytes);
          });
          ws.on('error', () => stop('protocol')); ws.on('close', () => stop('disconnected'));
          upstream!.on('end', () => stop('upstream')); upstream!.on('close', () => stop('upstream'));
          const accept = viewerStream(bytes => {
            if (Date.now() >= validUntil || Date.now() >= expires()) return stop('access_changed');
            if (upstream!.writableLength + bytes.length > 4 * 1024 * 1024) return stop('slow_viewer');
            upstream!.write(bytes);
          }, () => stop('protocol'), Boolean(ticket.leaseId));
          ws.on('message', (bytes, binary) => {
            if (!binary || !Buffer.isBuffer(bytes)) return stop('protocol');
            accept(bytes);
          });
          const display = desktopStream((bytes: Buffer) => {
            if (Date.now() >= validUntil || Date.now() >= expires()) return stop('access_changed');
            if (!room(bytes.length + 14)) return stop('slow_viewer');
            ws.send(bytes);
          }, () => stop('protocol'));
          upstream!.on('data', display);
        });
      } catch { stop('upstream'); }
    })().catch(async () => { await refusal('upgrade', match[1]); refuse(); }).finally(() => { if (reserved) opening--; });
  });
  if (controls) {
    let reconciling = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    app.addHook('onReady', async () => {
      await controls.reconcile();
      timer = setInterval(() => {
        if (reconciling) return; reconciling = true;
        void controls.reconcile().catch(() => app.log.error({ operation: 'control.recover' }, 'Control recovery unavailable; agent stays paused')).finally(() => { reconciling = false; });
      }, 250); timer.unref();
    });
    app.addHook('preClose', async () => { clearInterval(timer); await controls.close(); });
  }
  app.addHook('preClose', async () => {
    for (const stop of stops) stop('shutdown'); tickets.clear();
    await Promise.all(audits); wss.close();
  });
}
