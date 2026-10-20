import { once } from 'node:events';
import { createServer, type Socket } from 'node:net';
import { egressDestinationSchema } from '@opencrane/events';
import { connectEgressDestination, systemTransport, type EgressTransport } from './egress-guard.ts';

type Destination = { host: string; port: number };
type Registration = Destination & { permitId: string; expiresAt: number;
  recheck?: () => Promise<void>; confirm?: () => Promise<void> };
type CloseReason = 'finished' | 'failed' | 'refused' | 'expired' | 'revoked' | 'unavailable';
export type EgressCloseRecord = Destination & {
  permitId: string;
  address: string | null;
  reason: CloseReason;
  bytesSent: number;
  bytesReceived: number;
  registeredAt: number;
  connectedAt: number | null;
  closedAt: number;
};
type CloseRecord = (record: EgressCloseRecord) => void;

// Leave time for socket teardown inside the two-second outage limit.
const proofLifetimeMs = 1900;

export class EgressRecheckFailure extends Error {
  readonly reason: 'revoked' | 'unavailable';
  constructor(reason: 'revoked' | 'unavailable', cause: unknown) {
    super('egress_recheck_failed', { cause });
    this.reason = reason;
  }
}

class Relay {
  readonly listener = createServer(this.accept.bind(this));
  private incoming?: Socket;
  private upstream?: Socket;
  private address: string | null = null;
  private connectedAt: number | null = null;
  private closed = false;
  private checking = false;
  private pending: Promise<void> | undefined;
  private readonly watch: NodeJS.Timeout;
  private watchdog: NodeJS.Timeout | undefined;
  expiry: NodeJS.Timeout | undefined;
  private proofDeadline = performance.now() + proofLifetimeMs;

  readonly registration: Registration;
  private readonly registeredAt: number;
  private readonly onClose: CloseRecord;
  private readonly transport: EgressTransport;

  constructor(registration: Registration, registeredAt: number,
    onClose: CloseRecord, transport: EgressTransport) {
    this.registration = registration;
    this.registeredAt = registeredAt;
    this.onClose = onClose;
    this.transport = transport;
    this.watch = setInterval(this.check, 500);
    this.watch.unref();
    if (registration.recheck) this.watchProof();
  }

  close(reason: CloseReason) {
    if (this.closed) {
      return;
    }
    this.closed = true;
    clearInterval(this.watch);
    clearTimeout(this.watchdog);
    // Keep valid receipt times when the wall clock moves backwards.
    const closedAt = Math.max(Date.now(), this.registeredAt, this.connectedAt ?? 0);
    const record: EgressCloseRecord = {
      permitId: this.registration.permitId, host: this.registration.host,
      port: this.registration.port, address: this.address, reason,
      bytesSent: this.upstream?.bytesWritten ?? 0,
      bytesReceived: this.incoming?.bytesWritten ?? 0,
      registeredAt: this.registeredAt, connectedAt: this.connectedAt, closedAt,
    };
    this.incoming?.destroy();
    this.upstream?.destroy();
    try {
      this.onClose(record);
    } catch {
      // Keep callback failures from interrupting closure or causing a second record.
    }
  }

  stop(reason: CloseReason) {
    this.close(reason);
    clearTimeout(this.expiry);
    this.listener.close();
    return this.pending;
  }

  private watchProof = () => {
    const remaining = this.proofDeadline - performance.now();
    if (remaining <= 0) {
      this.close('unavailable');
      return;
    }
    this.watchdog = setTimeout(this.watchProof, remaining);
    this.watchdog.unref();
  };

  private check = () => {
    if (this.checking || this.closed || !this.registration.recheck) return;
    this.checking = true;
    const started = performance.now();
    const checking = this.refresh(started).catch(this.recheckFailed);
    this.pending = checking.finally(this.checked);
  };
  private async refresh(started: number) {
    await this.registration.recheck!();
    if (this.closed) return;
    if (performance.now() >= this.proofDeadline) {
      this.close('unavailable');
      return;
    }
    // Date proof from the start of its reads, never from a delayed reply.
    this.proofDeadline = started + proofLifetimeMs;
    clearTimeout(this.watchdog);
    this.watchProof();
  }
  private recheckFailed = (error: unknown) => {
    const reason = error instanceof EgressRecheckFailure ? error.reason : 'unavailable';
    this.close(reason);
  };
  private checked = () => {
    this.checking = false;
    this.pending = undefined;
  };

  private accept(socket: Socket) {
    if (this.closed || this.incoming || Date.now() >= this.registration.expiresAt) {
      socket.destroy();
      return;
    }
    this.incoming = socket;
    socket.on('error', this.failed);
    socket.on('end', this.finished);
    socket.on('close', this.finished);
    void this.forward(socket).catch(this.refused);
  }

  private finished = () => {
    this.close('finished');
  };
  private failed = () => {
    this.close('failed');
  };
  private refused = (error: unknown) => {
    if (error instanceof Error && error.message === 'egress_connect_refused') {
      this.close('failed');
      return;
    }
    this.close('refused');
  };

  private connect = (address: string, port: number) => {
    this.address = address;
    const upstream = this.transport.connect(address, port);
    this.upstream = upstream;
    upstream.on('error', this.failed);
    upstream.on('end', this.finished);
    upstream.on('close', this.finished);
    // Destroy a socket returned after a close inside an injected connector.
    if (this.closed) {
      upstream.destroy();
    }
    return upstream;
  };

  private async forward(socket: Socket) {
    const transport = { resolve: this.transport.resolve, connect: this.connect };
    const destination = { host: this.registration.host, port: this.registration.port };
    const result = await connectEgressDestination(socket, destination, transport);
    if (this.closed || Date.now() >= this.registration.expiresAt) {
      result.upstream.destroy();
      this.close('expired');
      return;
    }
    this.connectedAt = Math.max(Date.now(), this.registeredAt);
    result.upstream.write(result.initialData);
    socket.pipe(result.upstream);
    result.upstream.pipe(socket);
  }
}

export class EgressRelayRegistry {
  private stopped = false;
  private readonly permits = new Set<string>();
  private readonly relays = new Map<string, Relay>();
  private readonly closing: Promise<void>[] = [];

  private readonly onClose: CloseRecord;
  private readonly transport: EgressTransport;

  private readonly prepare: ((request: Registration) => Promise<void>) | undefined;

  constructor(onClose: CloseRecord, transport = systemTransport,
    prepare?: (request: Registration) => Promise<void>) {
    this.onClose = onClose;
    this.transport = transport;
    this.prepare = prepare;
  }

  async register(request: Registration): Promise<string> {
    const requestedDestination = { host: request.host, port: request.port };
    const destination = egressDestinationSchema.parse(requestedDestination);
    const registeredAt = Date.now();
    const lifetime = request.expiresAt - registeredAt;
    if (!Number.isFinite(lifetime) || lifetime <= 0 || lifetime > 60_000 ||
        this.stopped || !request.permitId || this.permits.has(request.permitId)) {
      throw new Error('egress_registration_refused');
    }
    // Reserve before awaiting the listener, so concurrent registrations cannot reuse a permit.
    this.permits.add(request.permitId);
    await this.prepare?.(request);
    await request.confirm?.();
    if (this.stopped) throw new Error('egress_registration_refused');
    const registration = { ...request, ...destination };
    const relay = new Relay(registration, registeredAt, this.onClose, this.transport);
    this.relays.set(request.permitId, relay);
    const relays = this.relays;
    function expire() {
      relay.close('expired');
      relay.listener.close();
      relays.delete(request.permitId);
    }
    const timer = setTimeout(expire, request.expiresAt - Date.now());
    relay.expiry = timer;
    timer.unref();
    try {
      relay.listener.listen(0, '127.0.0.1');
      await once(relay.listener, 'listening');
      const address = relay.listener.address();
      if (!address || typeof address === 'string') {
        throw new Error('egress_listener_refused');
      }
      // Keep the port bound until expiry, even after closure, to prevent reuse by another relay.
      relay.listener.unref();
      return `127.0.0.1:${address.port}`;
    } catch {
      clearTimeout(timer);
      relay.close('failed');
      relay.listener.close();
      this.relays.delete(request.permitId);
      throw new Error('egress_registration_refused');
    }
  }

  closePermit(permitId: string) {
    this.relays.get(permitId)?.close('revoked');
  }

  closeDestination(destination: Destination) {
    const parsed = egressDestinationSchema.parse(destination);
    for (const relay of this.relays.values()) {
      if (relay.registration.host === parsed.host && relay.registration.port === parsed.port) {
        relay.close('revoked');
      }
    }
  }

  closeAll(reason: 'revoked' | 'unavailable' = 'revoked') {
    this.stopped = true;
    for (const relay of this.relays.values()) {
      const pending = relay.stop(reason);
      if (pending) this.closing.push(pending);
    }
    this.relays.clear();
  }

  waitForChecks() {
    return Promise.all(this.closing);
  }
}
