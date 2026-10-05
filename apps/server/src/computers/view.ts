import { hasRoom, ViewDelivery } from './view-delivery.ts';
import {
  checkFailureDetails, checkOutcome, relativeLeaseExpiry, timeStage, viewTiming,
  leaseCheckDetails, type DesktopTiming,
} from './view-timing.ts';
import { viewerStream, desktopStream } from './rfb.ts';
import { confirmAccess, deadline, monotonicClock, ViewAccessUnconfirmed, ViewLease } from './view-lease.ts';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket, type RawData } from 'ws';
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
type StopReason = 'disconnected' | 'access_changed' | 'expired' | 'protocol'
  | 'slow_viewer' | 'upstream' | 'shutdown' | 'unavailable';
const admissionPath = /^\/api\/conversations\/([\w-]{1,200})\/view$/u;
export const liveViewPath = /^\/ws\/conversations\/([\w-]{1,200})\/view$/u;
type Computer = Awaited<ReturnType<typeof viewAccess>>;
type Timing = ReturnType<typeof viewTiming>;
interface StartAudit {
  started: ReturnType<typeof envelope>;
  auditData: Omit<Computer, 'podUid'> & {
    sessionId: string;
    memberId: string;
    conversationId: string;
    expiresAt: string;
  };
  sequence: number;
}
interface ViewerSession {
  request: IncomingMessage;
  socket: Duplex;
  head: Buffer;
  ticket: Ticket;
  computer: Computer;
  audit: StartAudit;
  expiresAt: number;
  timing: Timing;
  upgradeAt: number;
  sessionStartedAt: number;
  lease: ViewLease<Computer>;
  delivery: ViewDelivery;
  expiryTimer: ReturnType<typeof setTimeout>;
  stop: (reason: StopReason) => void;
  stopped: boolean;
  desktopOpening: boolean;
  upstream?: Duplex;
  upstreamAt?: number;
  viewer?: WebSocket;
}
function isUnconfirmed(error: unknown) {
  return error instanceof ViewAccessUnconfirmed || error instanceof ViewCheckUnavailable;
}
function closeCode(reason: StopReason) {
  if (reason === 'access_changed' || reason === 'expired') return 4003;
  if (reason === 'unavailable') return 4503;
  if (reason === 'slow_viewer') return 1013;
  return 1000;
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
  async function refusal(
    reason: 'admission' | 'upgrade' | 'capacity' | 'unavailable',
    conversationId?: string, memberId?: string,
  ) {
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
      const admittedMemberId = memberId;
      const admittedConversationId = conversationId;
      function checkMemberAccess() {
        return checkAccess(admittedMemberId, admittedConversationId, timing, 'admission');
      }
      await confirmAccess(checkMemberAccess);
      for (const [key, value] of tickets) if (value.redeemBy <= Date.now()) tickets.delete(key);
      if (tickets.size >= 1024 || stops.size + opening >= 16) throw new Error('View capacity');
      const ticket = randomBytes(32).toString('hex');
      tickets.set(ticket, { cookie, memberId, conversationId, sessionId,
        expires: Math.min(session.exp * 1000, Date.now() + 120_000), redeemBy: Date.now() + 15_000 });
      timing('ticket_issue', 'ok', performance.now() - admissionAt);
      return { ticket, sessionId };
    } catch (error) {
      if (isUnconfirmed(error)) {
        timing('ticket_issue', 'unavailable', performance.now() - admissionAt);
        const attemptId = await refusal('unavailable', conversationId, memberId);
        return reply.code(503).send({ status: 'unavailable', attemptId });
      }
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
    sessionStartedAt?: number,
    leaseValidUntil?: () => number | undefined,
  ) {
    const checkedAtMonotonic = performance.now();
    async function runCheck() {
      return deadline(viewAccess(accessOptions, memberId, conversationId));
    }
    function reportCheckSucceeded(durationMs: number) {
      const details = leaseCheckDetails(
        phase, checkedAtMonotonic, leaseValidUntil?.(), sessionStartedAt,
      );
      timing('lease_check', 'ok', durationMs, details);
    }
    function reportCheckFailed(error: unknown, durationMs: number) {
      const outcome = checkOutcome(error);
      const validUntilAt = leaseValidUntil?.();
      const failure = checkFailureDetails(
        phase, checkedAtMonotonic, validUntilAt, sessionStartedAt, error,
      );
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
  async function appendStartAudit(ticket: Ticket, computer: Computer, timing: Timing) {
    const { podUid: _podUid, ...identity } = computer;
    const auditData = {
      ...identity, sessionId: ticket.sessionId, memberId: ticket.memberId,
      conversationId: ticket.conversationId, expiresAt: new Date(ticket.expires).toISOString(),
    };
    const started = envelope(accessOptions.silo, `view-${ticket.sessionId}`,
      'computer.view_started', auditData);
    started.source = 'opencrane-server';
    started.principal = { kind: 'human', id: ticket.memberId };
    started.correlation = { conversation: ticket.conversationId };
    const command = { event: started, expectedSequence: 0 };
    async function append() {
      const result = await accessOptions.store.append(command);
      if (result.status !== 'appended') throw new Error('Audit unavailable');
      return result;
    }
    function reportStarted() {
      timing('start_audit', 'started');
    }
    function reportSucceeded(durationMs: number) {
      timing('start_audit', 'ok', durationMs);
    }
    function reportFailed(_error: unknown, durationMs: number) {
      timing('start_audit', 'error', durationMs);
    }
    const result = await timeStage(append, reportStarted, reportSucceeded, reportFailed);
    return { started, auditData, sequence: result.sequence };
  }

  type StartViewerSessionOptions = {
    request: IncomingMessage; socket: Duplex; head: Buffer; ticket: Ticket;
    computer: Computer; audit: StartAudit; expiresAt: number; timing: Timing; upgradeAt: number;
  };
  function startViewerSession(options: StartViewerSessionOptions) {
    const { request, socket, head, ticket, computer, audit, expiresAt, timing, upgradeAt } = options;
    const sessionStartedAt = monotonicClock.now();
    let firstCheck = true;
    function check() {
      let phase: 'post_audit' | 'renewal' = 'renewal';
      if (firstCheck) {
        firstCheck = false;
        phase = 'post_audit';
      }
      return checkAccess(ticket.memberId, ticket.conversationId, timing, phase,
        sessionStartedAt, lease.validUntilAt.bind(lease));
    }
    function resumed() {
      timing('lease_resume', 'ok');
      if (!session.desktopOpening) {
        session.desktopOpening = true;
        void openDesktop(session);
      }
      session.delivery.leaseResumed();
    }
    function renewed() {
      session.delivery.leaseRenewed();
    }
    function paused() {
      timing('lease_pause', 'unavailable');
      // Keeping transports open grants nothing; it only saves the reconnect.
      session.delivery.leasePaused();
    }
    function denied() {
      stopSession(session, 'access_changed');
    }
    function unconfirmed() {
      stopSession(session, 'unavailable');
    }
    function expired() {
      stopSession(session, 'expired');
    }
    function stop(reason: StopReason) {
      stopSession(session, reason);
    }
    function disconnected() {
      stopSession(session, 'disconnected');
    }
    const events = { resumed, renewed, paused, denied, unconfirmed };
    const lease: ViewLease<Computer> = new ViewLease(check, computer, events);
    const delivery = new ViewDelivery(lease, expiresAt, stop);
    const expiryTimer = setTimeout(expired, Math.max(0, expiresAt - monotonicClock.now()));
    const session: ViewerSession = {
      request, socket, head, ticket, computer, audit, expiresAt, timing, upgradeAt,
      lease, delivery, expiryTimer, stop, stopped: false, desktopOpening: false, sessionStartedAt,
    };
    stops.add(stop);
    socket.once('close', disconnected);
    if (socket.destroyed) {
      stopSession(session, 'disconnected');
      return;
    }
    // No authority check runs during the audit append. Only a later success opens the desktop.
    lease.start();
  }

  async function openDesktop(session: ViewerSession) {
    if (!canOpenDesktop(session)) return;
    session.upstreamAt = performance.now();
    const { timing } = session;
    function open() {
      return accessOptions.open(session.computer, timing);
    }
    function reportStarted() {
      timing('upstream_open', 'started');
    }
    function reportSucceeded(durationMs: number) {
      timing('upstream_open', 'ok', durationMs);
    }
    function reportFailed(_error: unknown, durationMs: number) {
      timing('upstream_open', 'error', durationMs);
    }
    try {
      const upstream = await timeStage(open, reportStarted, reportSucceeded, reportFailed);
      session.upstream = upstream;
      if (session.stopped || session.socket.destroyed || upstream.destroyed) {
        upstream.destroy();
        stopSession(session, 'upstream');
        return;
      }
      function connected(viewer: WebSocket) {
        connectViewer(session, viewer);
      }
      wss.handleUpgrade(session.request, session.socket, session.head, connected);
    } catch {
      stopSession(session, 'upstream');
    }
  }

  function canOpenDesktop(session: ViewerSession) {
    if (session.stopped) return false;
    const now = monotonicClock.now();
    if (now >= session.expiresAt) {
      stopSession(session, 'expired');
      return false;
    }
    return session.lease.allows(now);
  }

  function connectViewer(session: ViewerSession, viewer: WebSocket) {
    session.viewer = viewer;
    const { timing } = session;
    const upstream = session.upstream;
    if (!upstream) throw new Error('Desktop missing');
    session.delivery.attach(viewer, upstream);
    timing('websocket_upgrade', 'ok', performance.now() - session.upgradeAt);
    let pingWindow = Date.now();
    let pings = 0;
    function pong(bytes: Buffer) {
      if (session.stopped) return;
      if (Date.now() - pingWindow >= 1000) {
        pingWindow = Date.now();
        pings = 0;
      }
      pings++;
      if (pings > 16 || !hasRoom(viewer, bytes.length + 2)) {
        stopSession(session, 'slow_viewer');
        return;
      }
      viewer.pong(bytes);
    }
    function protocolFault() {
      stopSession(session, 'protocol');
    }
    function disconnected() {
      stopSession(session, 'disconnected');
    }
    function upstreamFault() {
      stopSession(session, 'upstream');
    }
    function forwardViewer(bytes: Buffer) {
      session.delivery.toDesktop(bytes);
    }
    const accept = viewerStream(forwardViewer, protocolFault);
    function receiveViewer(bytes: RawData, binary: boolean) {
      if (!binary || !Buffer.isBuffer(bytes)) {
        protocolFault();
        return;
      }
      accept(bytes);
    }
    let receivedBytes = false;
    let forwardedFrame = false;
    function forwardDisplay(bytes: Buffer, setup: boolean) {
      const delivered = session.delivery.toBrowser(bytes, setup);
      if (delivered && !setup && !forwardedFrame) {
        forwardedFrame = true;
        timing('first_browser_frame', 'ok', performance.now() - session.upstreamAt!);
      }
    }
    const display = desktopStream(forwardDisplay, protocolFault);
    function receiveDesktop(bytes: Buffer) {
      if (!receivedBytes) {
        receivedBytes = true;
        timing('first_upstream_bytes', 'ok', performance.now() - session.upstreamAt!);
      }
      display(bytes);
    }
    viewer.on('ping', pong);
    viewer.on('error', protocolFault);
    viewer.on('close', disconnected);
    viewer.on('message', receiveViewer);
    upstream.on('error', upstreamFault);
    upstream.on('end', upstreamFault);
    upstream.on('close', upstreamFault);
    upstream.on('data', receiveDesktop);
  }

  function stopSession(session: ViewerSession, reason: StopReason) {
    if (session.stopped) return;
    session.stopped = true;
    session.timing('stop', reason, 0,
      relativeLeaseExpiry(session.lease.validUntilAt(), session.sessionStartedAt));
    session.lease.stop();
    session.delivery.stop();
    clearTimeout(session.expiryTimer);
    stops.delete(session.stop);
    session.upstream?.destroy();
    if (session.viewer) {
      const viewer = session.viewer;
      viewer.close(closeCode(reason), reason);
      function terminate() {
        viewer.terminate();
      }
      const reap = setTimeout(terminate, 1000);
      reap.unref();
      function clearReap() {
        clearTimeout(reap);
      }
      viewer.once('close', clearReap);
    } else {
      session.timing('websocket_upgrade', reason, performance.now() - session.upgradeAt);
      session.socket.destroy();
    }
    void appendStopAudit(session, reason);
  }

  function appendStopAudit(session: ViewerSession, reason: StopReason) {
    const { started, auditData, sequence } = session.audit;
    const event = {
      ...started, id: randomUUID(), commandId: randomUUID(), type: 'computer.view_stopped',
      time: new Date().toISOString(), data: { ...auditData, reason },
    };
    async function append() {
      try {
        const command = { event, expectedSequence: sequence };
        const result = await accessOptions.store.append(command);
        if (result.status !== 'appended') throw new Error('View stop audit unavailable');
      } catch {
        const details = { operation: 'view.stop', sessionId: session.ticket.sessionId };
        app.log.error(details, 'View stop audit unavailable');
      }
    }
    const audit = append();
    audits.add(audit);
    function forgetAudit() {
      audits.delete(audit);
    }
    void audit.finally(forgetAudit);
    return audit;
  }

  async function handleViewerUpgrade(
    request: IncomingMessage, socket: Duplex, head: Buffer, conversationId: string,
  ) {
    function forbid() {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    }
    if (opening + stops.size >= 16) {
      await refusal('capacity', conversationId);
      forbid();
      return;
    }
    opening++;
    const upgradeAt = performance.now();
    let timing = viewTiming(app.log, randomUUID());
    let ticket: Ticket | undefined;
    try {
      ticket = redeem(request.headers, conversationId);
      const expiresAt = monotonicClock.now() + (ticket.expires - Date.now());
      timing = viewTiming(app.log, ticket.sessionId);
      timing('websocket_upgrade', 'started');
      const admitted = ticket;
      function check() {
        return checkAccess(admitted.memberId, conversationId, timing, 'upgrade');
      }
      const computer = await confirmAccess(check);
      const audit = await appendStartAudit(ticket, computer, timing);
      startViewerSession({ request, socket, head, ticket, computer, audit,
        expiresAt, timing, upgradeAt });
    } catch (error) {
      timing('websocket_upgrade', 'error', performance.now() - upgradeAt);
      if (error instanceof ViewAccessUnconfirmed) {
        await refusal('unavailable', conversationId, ticket?.memberId);
        socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      } else {
        await refusal('upgrade', conversationId, ticket?.memberId);
        forbid();
      }
    } finally {
      opening--;
    }
  }

  function viewerUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    const match = liveViewPath.exec(request.url ?? '');
    if (!match?.[1]) return;
    function socketError() {
      socket.destroy();
    }
    socket.on('error', socketError);
    void handleViewerUpgrade(request, socket, head, match[1]);
  }
  app.server.on('upgrade', viewerUpgrade);
  app.addHook('preClose', async () => {
    for (const stop of stops) stop('shutdown'); tickets.clear();
    await Promise.all(audits); wss.close();
  });
}
