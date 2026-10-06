// Use the shared protocol schemas for messages on /ws. Reconnect after a
// dropped connection with longer, varied waits so clients do not all retry
// at once after a server restart.
import { Injectable, type OnDestroy, computed, inject, signal } from '@angular/core';
import { Subject } from 'rxjs';
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

// Start with this wait, then double the maximum wait after each retry until
// it reaches the limit below.
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 30_000;

// Keep this many recent messages for subscribers that join late.
const MAX_HISTORY = 20;

  /** Use the page's host, with wss for HTTPS pages and ws for HTTP pages. */
function socketUrlFor(location: PageLocation): string {
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
  private readonly incoming = new Subject<ServerMessage>();
  /** Include each checked message, even when several arrive in one render. */
  readonly received = this.incoming.asObservable();

  /** The current connection state, for a status indicator. */
  readonly state = this.stateSignal.asReadonly();
  /** The most recent messages, in the order they arrived. */
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

  // Remove the handlers before closing. Browsers fire `close` later, and that
  // old event must not affect a replacement socket.
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

    // Ignore events from a socket after another socket has replaced it.
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
      // The socket fires close after error, and that handler schedules retries.
      // Log the error here without scheduling another retry.
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

  // Choose a random wait up to the growing limit. This spreads retries out
  // instead of making every client wait the same length of time.
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
    this.incoming.next(message);
    this.lastMessageSignal.set(message);
    this.historySignal.update((history) => [...history, message].slice(-MAX_HISTORY));
  }
}
