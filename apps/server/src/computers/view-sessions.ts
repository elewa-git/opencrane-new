import { randomBytes } from 'node:crypto';

// Allow time to connect without keeping unused tickets indefinitely.
const TICKET_TTL_MS = 15_000;
// Require a new admission after two minutes, or sooner when the sign-in expires.
const VIEW_TTL_MS = 120_000;
const MAX_TICKETS = 1024;
const MAX_SESSIONS = 16;

export type ViewTicket = {
  cookie: string;
  memberId: string;
  conversationId: string;
  sessionId: string;
  expires: number;
  redeemBy: number;
};
export type ViewStopReason = 'disconnected' | 'access_changed' | 'expired' | 'protocol'
  | 'slow_viewer' | 'upstream' | 'shutdown' | 'unavailable';
type StopSession = (reason: ViewStopReason) => void;

export class ViewSessions {
  private opening = 0;
  private readonly tickets = new Map<string, ViewTicket>();
  private readonly stops = new Set<StopSession>();
  private readonly audits = new Set<Promise<void>>();

  issueTicket(identity: Omit<ViewTicket, 'expires' | 'redeemBy'>, sessionExpiresAt: number) {
    for (const [key, ticket] of this.tickets) {
      if (ticket.redeemBy <= Date.now()) this.tickets.delete(key);
    }
    if (this.tickets.size >= MAX_TICKETS || !this.hasCapacity()) {
      throw new Error('View capacity');
    }
    const key = randomBytes(32).toString('hex');
    const ticket = {
      ...identity,
      expires: Math.min(sessionExpiresAt, Date.now() + VIEW_TTL_MS),
      redeemBy: Date.now() + TICKET_TTL_MS,
    };
    this.tickets.set(key, ticket);
    return key;
  }

  takeTicket(key: string) {
    const ticket = this.tickets.get(key);
    // Consume even an invalid redemption so a failed attempt cannot reuse the ticket.
    this.tickets.delete(key);
    return ticket;
  }

  async open(start: () => Promise<void>, refuse: () => Promise<void>) {
    if (!this.hasCapacity()) {
      await refuse();
      return;
    }
    this.opening++;
    try {
      await start();
    } finally {
      this.opening--;
    }
  }

  ownSession(stop: StopSession) {
    this.stops.add(stop);
    const stops = this.stops;
    function release() {
      // Deleting the same callback twice cannot release another viewer's place.
      stops.delete(stop);
    }
    return release;
  }

  async recordStop(append: () => Promise<void>) {
    const audit = append();
    this.audits.add(audit);
    try {
      await audit;
    } finally {
      this.audits.delete(audit);
    }
  }

  async shutdown() {
    for (const stop of this.stops) stop('shutdown');
    this.tickets.clear();
    await Promise.all(this.audits);
  }

  private hasCapacity() {
    return this.opening + this.stops.size < MAX_SESSIONS;
  }
}
