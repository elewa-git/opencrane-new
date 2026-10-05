import { monotonicClock, type LeaseClock, type ViewLease } from './view-lease.ts';

interface ViewerSink {
  send(data: Buffer | string): void;
  readonly bufferedAmount: number;
}
interface DesktopSink {
  write(data: Buffer): boolean;
  readonly writableLength: number;
}
type DeliveryFault = 'expired' | 'slow_viewer' | 'protocol';
const OUTPUT_LIMIT = 4 * 1024 * 1024;
const SETUP_LIMIT = 2048;
const INPUT_LIMIT = 8192;

export function hasRoom(viewer: Pick<ViewerSink, 'bufferedAmount'>, frameBytes: number) {
  // bufferedAmount includes socket and frame queues. Reserve the automatic close reply.
  return viewer.bufferedAmount + frameBytes + 127 <= OUTPUT_LIMIT;
}

export class ViewDelivery {
  private viewer: ViewerSink | undefined;
  private desktop: DesktopSink | undefined;
  private stopped = false;
  private pausedNoticeSent = false;
  private heldForBrowser: Buffer[] = [];
  private heldForDesktop: Buffer[] = [];
  private browserBytes = 0;
  private desktopBytes = 0;

  private readonly lease: Pick<ViewLease<unknown>, 'allows' | 'notice'>;
  private readonly expiresAt: number;
  private readonly stopSession: (reason: DeliveryFault) => void;
  private readonly clock: LeaseClock;

  constructor(
    lease: Pick<ViewLease<unknown>, 'allows' | 'notice'>,
    expiresAt: number,
    stopSession: (reason: DeliveryFault) => void,
    clock: LeaseClock = monotonicClock,
  ) {
    this.lease = lease;
    this.expiresAt = expiresAt;
    this.stopSession = stopSession;
    this.clock = clock;
  }

  attach(viewer: ViewerSink, desktop: DesktopSink) {
    if (this.stopped) return;
    this.viewer = viewer;
    this.desktop = desktop;
    this.sendNotice();
  }

  toBrowser(message: Buffer, setup: boolean): boolean {
    if (!this.active() || !this.viewer) return false;
    const allowed = this.lease.allows(this.clock.now());
    // allows() can send the paused notice and stop delivery when the lease lapses.
    if (this.stopped) return false;
    if (!allowed) {
      this.sendNotice();
      if (setup && !this.stopped) this.holdForBrowser(message);
      return false;
    }
    if (!hasRoom(this.viewer, message.length + 14)) {
      this.fail('slow_viewer');
      return false;
    }
    this.viewer.send(message);
    return true;
  }

  toDesktop(message: Buffer) {
    if (!this.active() || !this.desktop) return;
    const allowed = this.lease.allows(this.clock.now());
    // allows() can send the paused notice and stop delivery when the lease lapses.
    if (this.stopped) return;
    if (!allowed) {
      this.sendNotice();
      if (!this.stopped) this.holdForDesktop(message);
      return;
    }
    if (this.desktop.writableLength + message.length > OUTPUT_LIMIT) {
      this.fail('slow_viewer');
      return;
    }
    this.desktop.write(message);
  }

  leaseResumed() {
    this.sendNotice();
    if (this.stopped || !this.viewer) return;
    // The notice must precede setup; setup must precede the viewer's held replies.
    const browser = this.heldForBrowser;
    this.heldForBrowser = [];
    this.browserBytes = 0;
    for (const message of browser) this.toBrowser(message, true);
    const desktop = this.heldForDesktop;
    this.heldForDesktop = [];
    this.desktopBytes = 0;
    for (const message of desktop) this.toDesktop(message);
  }

  leaseRenewed() {
    this.sendNotice();
  }

  leasePaused() {
    this.sendNotice();
  }

  stop() {
    this.stopped = true;
    this.heldForBrowser = [];
    this.heldForDesktop = [];
    this.browserBytes = 0;
    this.desktopBytes = 0;
  }

  private active() {
    if (this.stopped) return false;
    if (this.clock.now() >= this.expiresAt) {
      this.fail('expired');
      return false;
    }
    return true;
  }

  private sendNotice() {
    if (!this.active() || !this.viewer) return;
    const notice = this.lease.notice();
    // notice() can synchronously lapse the lease and re-enter this method.
    if (this.stopped || (notice.lease === 'paused' && this.pausedNoticeSent)) return;
    const text = JSON.stringify(notice);
    if (!hasRoom(this.viewer, Buffer.byteLength(text) + 14)) {
      this.fail('slow_viewer');
      return;
    }
    this.pausedNoticeSent = notice.lease === 'paused';
    this.viewer.send(text);
  }

  private holdForBrowser(message: Buffer) {
    // Only setup is retained. Bounds prevent a paused peer retaining unbounded memory.
    if (this.browserBytes + message.length > SETUP_LIMIT) {
      this.fail('protocol');
      return;
    }
    this.heldForBrowser.push(Buffer.from(message));
    this.browserBytes += message.length;
  }

  private holdForDesktop(message: Buffer) {
    if (this.desktopBytes + message.length > INPUT_LIMIT) {
      this.fail('slow_viewer');
      return;
    }
    this.heldForDesktop.push(Buffer.from(message));
    this.desktopBytes += message.length;
  }

  private fail(reason: DeliveryFault) {
    this.stop();
    this.stopSession(reason);
  }
}
