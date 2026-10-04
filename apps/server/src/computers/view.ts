import { timeStage, viewTiming, type DesktopTiming } from './view-timing.ts';
import { viewerStream, desktopStream } from './rfb.ts';
import type { IncomingHttpHeaders } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { FastifyInstance } from 'fastify';
import { decodeSession, isIdentityAllowed, parseCookieHeader, type AuthConfig } from '@opencrane/auth';
import type { connectMemberFeed } from '@opencrane/projections';
import { envelope } from '@opencrane/models';
import { viewAccess, ViewCheckUnavailable, type ViewAccessOptions } from './view-access.ts';

export interface LiveViewOptions extends ViewAccessOptions {
  feed: Pick<Awaited<ReturnType<typeof connectMemberFeed>>, 'memberId'>;
  open(
    computer: { computerId: string; generation: number; podUid?: string | undefined },
    observe?: DesktopTiming,
  ): Promise<Duplex>;
}
type Ticket = { cookie: string; memberId: string; conversationId: string; sessionId: string; expires: number; redeemBy: number };
type StopReason = 'disconnected' | 'access_changed' | 'expired' | 'protocol' | 'slow_viewer' | 'upstream' | 'shutdown';
const admissionPath = /^\/api\/conversations\/([\w-]{1,200})\/view$/u;
export const liveViewPath = /^\/ws\/conversations\/([\w-]{1,200})\/view$/u;
function deadline<T>(work: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    // Include event reads around OpenFGA's one-second call; the desktop lease remains 1.5 seconds.
    const timer = setTimeout(() => reject(new ViewCheckUnavailable('deadline')), 1200);
    void work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

export function registerLiveView(app: FastifyInstance, config: AuthConfig, options?: LiveViewOptions) {
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
  app.post('/api/conversations/:conversationId/view', { bodyLimit: 1024 }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    if (!options) return reply.code(503).send({ status: 'unavailable' });
    let memberId: string | undefined;
    const conversationId = admissionPath.exec(request.url)?.[1];
    const sessionId = randomUUID();
    const timing = viewTiming(app.log, sessionId);
    const admissionAt = performance.now();
    timing('ticket_issue', 'started');
    try {
      const { session, cookie } = authenticate(request.headers);
      if (!conversationId || request.headers['x-opencrane-view'] !== '1') throw new Error('CSRF check failed');
      memberId = (await deadline(options.feed.memberId(options.silo, config.issuerUrl, session.sub))) ?? undefined;
      if (!memberId) throw new Error('Member required');
      await checkAccess(memberId, conversationId, timing, 'admission');
      for (const [key, value] of tickets) if (value.redeemBy <= Date.now()) tickets.delete(key);
      if (tickets.size >= 1024 || stops.size + opening >= 16) throw new Error('View capacity');
      const ticket = randomBytes(32).toString('hex');
      tickets.set(ticket, { cookie, memberId, conversationId, sessionId,
        expires: Math.min(session.exp * 1000, Date.now() + 120_000), redeemBy: Date.now() + 15_000 });
      timing('ticket_issue', 'ok', performance.now() - admissionAt);
      return { ticket, sessionId };
    } catch {
      timing('ticket_issue', 'denied', performance.now() - admissionAt);
      const attemptId = await refusal('admission', conversationId, memberId);
      return reply.code(403).send({ status: 'refused', attemptId });
    }
  });
  if (!options) { wss.close(); return; }
  const accessOptions = options;
  async function checkAccess(
    memberId: string,
    conversationId: string,
    timing: ReturnType<typeof viewTiming>,
    phase: 'admission' | 'upgrade' | 'post_audit' | 'renewal',
    validUntil?: number,
    checkedAt = Date.now(),
  ) {
    const details: { phase: typeof phase; checkedAt: number; validUntil?: number } = {
      phase,
      checkedAt,
    };
    if (validUntil !== undefined) details.validUntil = validUntil;
    function outcomeForCheckError(error: unknown) {
      if (error instanceof ViewCheckUnavailable) return 'unavailable' as const;
      return 'denied' as const;
    }
    function detailsForCheckError(error: unknown) {
      const failure: typeof details & {
        boundary?: 'event_store' | 'authorisation' | 'deadline';
      } = { ...details };
      if (error instanceof ViewCheckUnavailable) failure.boundary = error.boundary;
      return failure;
    }
    async function runCheck() {
      return deadline(viewAccess(accessOptions, memberId, conversationId));
    }
    function reportCheckSucceeded(durationMs: number) {
      timing('lease_check', 'ok', durationMs, details);
    }
    function reportCheckFailed(error: unknown, durationMs: number) {
      const outcome = outcomeForCheckError(error);
      const failure = detailsForCheckError(error);
      timing('lease_check', outcome, durationMs, failure);
    }
    return timeStage(runCheck, undefined, reportCheckSucceeded, reportCheckFailed);
  }
  function redeem(headers: IncomingHttpHeaders, conversationId: string) {
    const { cookie } = authenticate(headers);
    const protocols = headers['sec-websocket-protocol']?.split(',').map(s => s.trim());
    const key = protocols?.[1] ?? '';
    const ticket = tickets.get(key);
    tickets.delete(key);
    if (protocols?.[0] !== 'binary' || !ticket || ticket.cookie !== cookie
      || ticket.redeemBy <= Date.now() || ticket.conversationId !== conversationId) {
      throw new Error('Invalid ticket');
    }
    return ticket;
  }
  app.server.on('upgrade', (request, socket, head) => {
    const match = liveViewPath.exec(request.url ?? '');
    if (!match) return;
    socket.on('error', () => socket.destroy());
    const refuse = () => socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    if (opening + stops.size >= 16) { void refusal('capacity', match[1]).then(refuse); return; }
    opening++; let reserved = true;
    const upgradeAt = performance.now();
    // Keep rejected upgrades correlatable before a ticket supplies the admitted session id.
    let timing = viewTiming(app.log, randomUUID());
    void (async () => {
      if (!options) throw new Error('View unavailable');
      const ticket = redeem(request.headers, match[1]!);
      timing = viewTiming(app.log, ticket.sessionId);
      timing('websocket_upgrade', 'started');
      const computer = await checkAccess(
        ticket.memberId, ticket.conversationId, timing, 'upgrade',
      );
      const data = { ...computer, sessionId: ticket.sessionId, memberId: ticket.memberId, conversationId: ticket.conversationId, expiresAt: new Date(ticket.expires).toISOString() };
      const { podUid: _podUid, ...auditData } = data;
      const started = envelope(options.silo, `view-${ticket.sessionId}`, 'computer.view_started', auditData);
      started.source = 'opencrane-server'; started.principal = { kind: 'human', id: ticket.memberId }; started.correlation = { conversation: ticket.conversationId };
      const command = { event: started, expectedSequence: 0 };
      async function appendStartAudit() {
        const result = await accessOptions.store.append(command);
        if (result.status !== 'appended') throw new Error('Audit unavailable');
        return result;
      }
      function reportAuditStarted() {
        timing('start_audit', 'started');
      }
      function reportAuditSucceeded(durationMs: number) {
        timing('start_audit', 'ok', durationMs);
      }
      function reportAuditFailed(_error: unknown, durationMs: number) {
        timing('start_audit', 'error', durationMs);
      }
      const result = await timeStage(
        appendStartAudit,
        reportAuditStarted,
        reportAuditSucceeded,
        reportAuditFailed,
      );
      // Include the check after the start audit in the limit of five outstanding checks.
      let viewer: WebSocket | undefined, upstream: Duplex | undefined, stopped = false, checking = 1;
      let validUntil = Date.now() + 1500, renewedAt = 0;
      const stop = (reason: StopReason) => {
        if (stopped) return;
        const lease = { validUntil };
        timing('stop', reason, 0, lease);
        stopped = true; clearInterval(timer); stops.delete(stop);
        upstream?.destroy();
        if (viewer) { viewer.close(reason === 'access_changed' || reason === 'expired' ? 4003 : reason === 'slow_viewer' ? 1013 : 1000, reason);
          const reap = setTimeout(() => viewer?.terminate(), 1000); reap.unref(); viewer.once('close', () => clearTimeout(reap));
        } else {
          timing('websocket_upgrade', reason, performance.now() - upgradeAt);
          socket.destroy();
        }
        const event = { ...started, id: randomUUID(), commandId: randomUUID(), type: 'computer.view_stopped', time: new Date().toISOString(), data: { ...auditData, reason } };
        const audit = options.store.append({ event, expectedSequence: result.sequence }).then(outcome => {
          if (outcome.status !== 'appended') throw new Error('View stop audit unavailable');
        }).catch(() => { app.log.error({ operation: 'view.stop', sessionId: ticket.sessionId }, 'View stop audit unavailable'); });
        audits.add(audit); void audit.finally(() => audits.delete(audit));
      };
      const timer = setInterval(() => {
        if (Date.now() >= ticket.expires) return stop('expired');
        if (Date.now() >= validUntil) return stop('access_changed');
        // Five checks cover the 1200ms deadline without skipping a 250ms start.
        if (checking >= 5) return;
        checking++;
        const checkedAt = Date.now();
        void checkAccess(
          ticket.memberId, ticket.conversationId, timing, 'renewal', validUntil, checkedAt,
        ).then(current => {
          if (JSON.stringify(current) !== JSON.stringify(computer)) return stop('access_changed');
          // A delayed reply must not extend the age of the authority snapshot.
          renewedAt = Math.max(renewedAt, checkedAt);
          validUntil = Math.max(validUntil, checkedAt + 1500);
        }, (error: unknown) => {
          // A missed check cannot revoke a lease renewed by another check.
          // It grants no extra time: the existing snapshot still expires at validUntil.
          if (!(error instanceof ViewCheckUnavailable)) stop('access_changed');
        }).finally(() => { checking--; });
      }, 250);
      stops.add(stop); opening--; reserved = false; socket.once('close', () => stop('disconnected'));
      if (socket.destroyed) { stop('disconnected'); return; }
      try {
        // Audit persistence can wait long enough for authority or the cookie to expire.
        const checkedAt = Date.now();
        const current = await checkAccess(
          ticket.memberId, ticket.conversationId, timing, 'post_audit', validUntil, checkedAt,
        ).catch((error: unknown) => {
          // A newer, successful post-audit check can satisfy this same admission fence.
          // Its lease already ends at or after checkedAt + 1500; this grants no extra time.
          return error instanceof ViewCheckUnavailable && renewedAt >= checkedAt && Date.now() < validUntil ? computer : undefined;
        }).finally(() => { checking--; });
        if (stopped || !current || JSON.stringify(current) !== JSON.stringify(computer)) { stop('access_changed'); return; }
        if (Date.now() >= ticket.expires) { stop('expired'); return; }
        validUntil = Math.max(validUntil, checkedAt + 1500);
        const upstreamAt = performance.now();
        async function openUpstream() {
          return accessOptions.open(computer, timing);
        }
        function reportUpstreamStarted() {
          timing('upstream_open', 'started');
        }
        function reportUpstreamSucceeded(durationMs: number) {
          timing('upstream_open', 'ok', durationMs);
        }
        function reportUpstreamFailed(_error: unknown, durationMs: number) {
          timing('upstream_open', 'error', durationMs);
        }
        upstream = await timeStage(
          openUpstream,
          reportUpstreamStarted,
          reportUpstreamSucceeded,
          reportUpstreamFailed,
        );
        if (stopped || socket.destroyed || upstream.destroyed) { upstream.destroy(); stop('upstream'); return; }
        wss.handleUpgrade(request, socket, head, ws => {
          viewer = ws;
          timing('websocket_upgrade', 'ok', performance.now() - upgradeAt);
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
          upstream!.on('error', () => stop('upstream')); upstream!.on('end', () => stop('upstream')); upstream!.on('close', () => stop('upstream'));
          const accept = viewerStream(bytes => {
            if (upstream!.writableLength + bytes.length > 4 * 1024 * 1024) return stop('slow_viewer');
            upstream!.write(bytes);
          }, () => stop('protocol'));
          ws.on('message', (bytes, binary) => {
            if (!binary || !Buffer.isBuffer(bytes)) return stop('protocol');
            accept(bytes);
          });
          let receivedBytes = false;
          let forwardedFrame = false;
          function forwardDisplay(bytes: Buffer, framebuffer: boolean) {
            if (Date.now() >= validUntil || Date.now() >= ticket.expires) return stop('access_changed');
            if (!room(bytes.length + 14)) return stop('slow_viewer');
            ws.send(bytes);
            if (framebuffer && !forwardedFrame) {
              forwardedFrame = true;
              timing('first_browser_frame', 'ok', performance.now() - upstreamAt);
            }
          }
          function refuseDisplay() {
            stop('protocol');
          }
          const display = desktopStream(forwardDisplay, refuseDisplay);
          function receive(bytes: Buffer) {
            if (!receivedBytes) {
              receivedBytes = true;
              timing('first_upstream_bytes', 'ok', performance.now() - upstreamAt);
            }
            display(bytes);
          }
          upstream!.on('data', receive);
        });
      } catch { stop('upstream'); }
    })().catch(async () => {
      timing('websocket_upgrade', 'error', performance.now() - upgradeAt);
      await refusal('upgrade', match[1]);
      refuse();
    }).finally(() => { if (reserved) opening--; });
  });
  app.addHook('preClose', async () => {
    for (const stop of stops) stop('shutdown'); tickets.clear();
    await Promise.all(audits); wss.close();
  });
}
