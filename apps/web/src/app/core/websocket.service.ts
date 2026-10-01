// A signals-based WebSocket client for the /ws endpoint. It speaks the
// typed protocol from @opencrane/protocol (the same schemas the server
// uses, not a copy) and reconnects on its own when the connection drops,
// waiting longer each time with a random jitter so a server restart is not
// met with every client retrying at once.
import { Injectable, type OnDestroy, computed, inject, signal } from '@angular/core';
import { serverMessageSchema, type ClientMessage, type ServerMessage } from '@opencrane/protocol';
import {
  PAGE_LOCATION,
  RANDOM_SOURCE,
  SOCKET_FACTORY,
  SOCKET_OPEN,
  type PageLocation,
  type SocketLike,
} from './socket-factory';

export type ConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

// The first retry waits about this long, then each further retry's cap
// doubles, up to the maximum below.
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 30_000;

// How many past messages the service keeps around for a late subscriber.
const MAX_HISTORY = 20;

/** The /ws address on the page's own host: wss on an https page (ws would be blocked as mixed content), ws otherwise. */
export function socketUrlFor(location: PageLocation): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}/ws`;
}

@Injectable({ providedIn: 'root' })
export class WebSocketService implements OnDestroy {
  private readonly createSocket = inject(SOCKET_FACTORY);
  private readonly random = inject(RANDOM_SOURCE);
  private readonly pageLocation = inject(PAGE_LOCATION);

  private socket: SocketLike | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectAttempt = 0;
  private userClosed = false;

  private readonly stateSignal = signal<ConnectionState>('idle');
  private readonly historySignal = signal<ServerMessage[]>([]);
  private readonly lastMessageSignal = signal<ServerMessage | undefined>(undefined);

  /** The current connection state, for a status indicator. */
  readonly state = this.stateSignal.asReadonly();
  /** The last {@link MAX_HISTORY} messages received, oldest first. */
  readonly messages = this.historySignal.asReadonly();
  /** The most recently received message, if any. */
  readonly lastMessage = this.lastMessageSignal.asReadonly();
  /** True only once the socket is actually open. */
  readonly isConnected = computed(() => this.stateSignal() === 'open');

  /**
   * Opens the socket. Safe to call again at any time: while idle, while
   * connected (the old socket is closed first), or after {@link disconnect}.
   */
  connect(url: string = socketUrlFor(this.pageLocation)): void {
    this.userClosed = false;
    this.clearReconnectTimer();
    this.reconnectAttempt = 0;
    this.closeSocket('reconnecting');
    this.open(url);
  }

  /** Closes the socket and stops any pending reconnect. */
  disconnect(): void {
    this.userClosed = true;
    this.clearReconnectTimer();
    this.reconnectAttempt = 0;
    this.closeSocket('client closed');
    this.stateSignal.set('closed');
  }

  /** Sends a typed message. Returns false without throwing if the socket is not open. */
  send(message: ClientMessage): boolean {
    if (!this.socket || this.socket.readyState !== SOCKET_OPEN) {
      return false;
    }
    this.socket.send(JSON.stringify(message));
    return true;
  }

  ngOnDestroy(): void {
    this.disconnect();
  }

  // Detaches the handlers before closing. A real browser fires `close` on
  // its own later turn, and that late event must not touch whatever socket
  // replaced this one.
  private closeSocket(reason: string): void {
    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      socket.onopen = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
      socket.close(1000, reason);
    }
  }

  private open(url: string): void {
    this.stateSignal.set(this.reconnectAttempt > 0 ? 'reconnecting' : 'connecting');
    const socket = this.createSocket(url);
    this.socket = socket;

    // Each handler ignores events once this is no longer the current socket.
    socket.onopen = () => {
      if (this.socket !== socket) {
        return;
      }
      this.reconnectAttempt = 0;
      this.stateSignal.set('open');
    };

    socket.onmessage = (event: MessageEvent) => {
      if (this.socket !== socket) {
        return;
      }
      const data: unknown = event.data;
      this.handleRawMessage(typeof data === 'string' ? data : String(data));
    };

    socket.onerror = () => {
      if (this.socket !== socket) {
        return;
      }
      // A WebSocket always fires close right after error, so the retry is
      // scheduled there; this is only somewhere to see the failure logged.
      console.warn('[websocket] connection error');
    };

    socket.onclose = () => {
      if (this.socket !== socket) {
        return;
      }
      this.socket = undefined;
      if (this.userClosed) {
        this.stateSignal.set('closed');
        return;
      }
      this.scheduleReconnect(url);
    };
  }

  private scheduleReconnect(url: string): void {
    this.stateSignal.set('reconnecting');
    const delay = this.nextDelay();
    this.reconnectAttempt += 1;
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      if (!this.userClosed) {
        this.open(url);
      }
    }, delay);
  }

  // Full jitter backoff (as described in the AWS backoff writeup): a
  // random wait between 0 and the exponential cap. This spreads retries
  // out instead of every client waiting the same length of time.
  private nextDelay(): number {
    const cap = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** this.reconnectAttempt);
    return Math.round(this.random() * cap);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private handleRawMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.warn('[websocket] received a message that was not valid JSON');
      return;
    }

    const message = serverMessageSchema.safeParse(parsed);
    if (!message.success) {
      console.warn('[websocket] received a message that did not match the known protocol');
      return;
    }
    this.pushMessage(message.data);
  }

  private pushMessage(message: ServerMessage): void {
    this.lastMessageSignal.set(message);
    this.historySignal.update((history) => [...history, message].slice(-MAX_HISTORY));
  }
}
