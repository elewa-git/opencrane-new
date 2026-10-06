import type { RawChannel } from '@novnc/novnc/lib/rfb.js';

export type LeaseNotice = { lease: 'paused' } | { lease: 'valid'; at: number; until: number };
const HANDSHAKE_REPLY_BYTES = 14;
interface ChannelEvents {
  notice(notice: LeaseNotice): void;
  invalid(): void;
}

export function parseLeaseNotice(text: string): LeaseNotice | undefined {
  let notice: unknown;
  try { notice = JSON.parse(text); } catch { return undefined; }
  if (!notice || typeof notice !== 'object' || !('lease' in notice)) return undefined;
  const keys = Object.keys(notice);
  if (notice.lease === 'paused' && keys.length === 1) return { lease: 'paused' };
  if (notice.lease !== 'valid' || keys.length !== 3 ||
    !('at' in notice) || !('until' in notice)) return undefined;
  const { at, until } = notice;
  if (typeof at !== 'number' || typeof until !== 'number') return undefined;
  if (!validLeaseTimes(at, until)) return undefined;
  return { lease: 'valid', at, until };
}

function validLeaseTimes(at: number, until: number) {
  if (!Number.isSafeInteger(at) || !Number.isSafeInteger(until) || at < 0) return false;
  const remaining = until - at;
  return remaining >= 1 && remaining <= 1500;
}

export class LeaseChannel {
  private port: ViewerPort | undefined;
  private readonly handshake: ArrayBuffer[] = [];
  private offset = Infinity;
  private readonly socket: WebSocket;
  private readonly events: ChannelEvents;

  constructor(socket: WebSocket, events: ChannelEvents) {
    this.socket = socket;
    this.events = events;
    socket.binaryType = 'arraybuffer';
    socket.addEventListener('message', this.receive.bind(this));
    socket.addEventListener('open', this.opened.bind(this));
    socket.addEventListener('error', this.failed.bind(this));
    socket.addEventListener('close', this.closed.bind(this));
  }

  get handshakeComplete() { return this.handshake.length === 4; }

  attachViewer() {
    this.detachViewer();
    const port = new ViewerPort(this.socket, this.handshakeComplete, this.events);
    this.port = port;
    return port;
  }

  replayHandshake() {
    const port = this.port;
    if (!port || !this.handshakeComplete) return;
    for (const data of this.handshake) {
      if (this.port !== port) return;
      const options = { data };
      const event = new MessageEvent('message', options);
      port.onmessage?.(event);
    }
  }

  detachViewer() {
    const port = this.port;
    this.port = undefined;
    port?.detach();
  }

  localDeadline(notice: Extract<LeaseNotice, { lease: 'valid' }>) {
    // Keep the first measured clock difference when a notice arrives after the image.
    this.offset = Math.min(this.offset, performance.now() - notice.at);
    return notice.until + this.offset;
  }

  private receive(event: MessageEvent<unknown>) {
    if (typeof event.data === 'string') {
      const notice = parseLeaseNotice(event.data);
      if (!notice) this.events.invalid();
      else this.events.notice(notice);
      return;
    }
    if (!(event.data instanceof ArrayBuffer)) {
      this.events.invalid();
      return;
    }
    if (!this.handshakeComplete) this.handshake.push(event.data.slice(0));
    // A detached viewer has no image buffer where paused updates could build up.
    if (this.port?.readyState !== WebSocket.CLOSED) this.port?.onmessage?.(event);
  }

  private opened(event: Event) { this.port?.onopen?.(event); }
  private failed(event: Event) { this.port?.onerror?.(event); }
  private closed(event: CloseEvent) { this.port?.onclose?.(event); }
}

class ViewerPort implements RawChannel {
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  private detached = false;
  private handshakeBytesSwallowed: number;
  private readonly socket: WebSocket;
  private readonly events: ChannelEvents;
  private closeNotified = false;
  private readonly expected = new TextEncoder().encode('RFB 003.008\n\x01\x01');

  constructor(
    socket: WebSocket, replay: boolean,
    events: ChannelEvents,
  ) {
    this.socket = socket;
    this.events = events;
    this.handshakeBytesSwallowed = replay ? 0 : HANDSHAKE_REPLY_BYTES;
  }

  get binaryType() { return this.socket.binaryType; }
  set binaryType(value: BinaryType) { this.socket.binaryType = value; }
  get protocol() { return this.socket.protocol; }
  get readyState() { return this.detached ? WebSocket.CLOSED : this.socket.readyState; }

  send(data: ArrayBuffer | ArrayBufferView<ArrayBuffer>) {
    if (this.detached) return;
    if (this.handshakeBytesSwallowed === HANDSHAKE_REPLY_BYTES) {
      this.socket.send(data);
      return;
    }
    let bytes: Uint8Array;
    if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
    else bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    let consumed = 0;
    while (consumed < bytes.length && this.handshakeBytesSwallowed < HANDSHAKE_REPLY_BYTES) {
      const expectedIndex = this.handshakeBytesSwallowed;
      if (bytes[consumed] !== this.expected[expectedIndex]) {
        this.events.invalid();
        return;
      }
      consumed++;
      this.handshakeBytesSwallowed++;
    }
    if (consumed < bytes.length) this.socket.send(bytes.subarray(consumed));
  }

  close() {
    // noVNC starts this timer after close() returns. The component then calls
    // detachViewer(), and its close event clears the timer straight away.
    this.detached = true;
  }

  detach() {
    if (this.closeNotified) return;
    this.detached = true;
    this.closeNotified = true;
    const options = { code: 1000, reason: 'paused', wasClean: true };
    const event = new CloseEvent('close', options);
    this.onclose?.(event);
  }
}
