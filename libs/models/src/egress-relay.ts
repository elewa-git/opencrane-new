import { once } from 'node:events';
import { createServer, type Socket } from 'node:net';
import { egressDestinationSchema } from '@opencrane/events';
import { connectEgressDestination, systemTransport, type EgressTransport } from './egress-guard.ts';

type Destination = { host: string; port: number };
type Registration = Destination & { permitId: string; expiresAt: number };
type CloseReason = 'finished' | 'failed' | 'refused' | 'expired' | 'revoked';
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

class Relay {
  readonly listener = createServer(this.accept.bind(this));
  private incoming?: Socket;
  private upstream?: Socket;
  private address: string | null = null;
  private connectedAt: number | null = null;
  private closed = false;

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
  }

  close(reason: CloseReason) {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const record: EgressCloseRecord = {
      permitId: this.registration.permitId, host: this.registration.host,
      port: this.registration.port, address: this.address, reason,
      bytesSent: this.upstream?.bytesWritten ?? 0,
      bytesReceived: this.incoming?.bytesWritten ?? 0,
      registeredAt: this.registeredAt, connectedAt: this.connectedAt, closedAt: Date.now(),
    };
    this.incoming?.destroy();
    this.upstream?.destroy();
    try {
      this.onClose(record);
    } catch {
      // Keep callback failures from interrupting closure or causing a second record.
    }
  }

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
    this.connectedAt = Date.now();
    result.upstream.write(result.initialData);
    socket.pipe(result.upstream);
    result.upstream.pipe(socket);
  }
}

export class EgressRelayRegistry {
  private readonly permits = new Set<string>();
  private readonly relays = new Map<string, Relay>();

  private readonly onClose: CloseRecord;
  private readonly transport: EgressTransport;

  constructor(onClose: CloseRecord, transport = systemTransport) {
    this.onClose = onClose;
    this.transport = transport;
  }

  async register(request: Registration): Promise<string> {
    const requestedDestination = { host: request.host, port: request.port };
    const destination = egressDestinationSchema.parse(requestedDestination);
    const registeredAt = Date.now();
    const lifetime = request.expiresAt - registeredAt;
    if (!Number.isFinite(lifetime) || lifetime <= 0 || lifetime > 60_000 ||
        !request.permitId || this.permits.has(request.permitId)) {
      throw new Error('egress_registration_refused');
    }
    // Reserve before awaiting the listener, so concurrent registrations cannot reuse a permit.
    this.permits.add(request.permitId);
    const registration = { ...request, ...destination };
    const relay = new Relay(registration, registeredAt, this.onClose, this.transport);
    this.relays.set(request.permitId, relay);
    const relays = this.relays;
    function expire() {
      relay.close('expired');
      relay.listener.close();
      relays.delete(request.permitId);
    }
    const timer = setTimeout(expire, lifetime);
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

  closeAll() {
    for (const relay of this.relays.values()) {
      relay.close('revoked');
    }
  }
}
