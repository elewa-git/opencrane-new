import type { FastifyBaseLogger } from 'fastify';

export type DesktopTiming = (
  stage: 'pod_lookup' | 'desktop_connect',
  outcome: 'started' | 'ok' | 'error',
  durationMs: number,
) => void;

type Stage = 'ticket_issue' | 'websocket_upgrade' | 'start_audit' | 'upstream_open'
  | 'pod_lookup' | 'desktop_connect' | 'first_upstream_bytes' | 'first_browser_frame'
  | 'lease_check' | 'stop';
type Outcome = 'started' | 'ok' | 'unavailable' | 'denied' | 'error'
  | 'disconnected' | 'access_changed' | 'expired' | 'protocol' | 'slow_viewer'
  | 'upstream' | 'shutdown';
interface Details {
  boundary?: 'event_store' | 'authorisation' | 'deadline';
  phase?: 'admission' | 'upgrade' | 'post_audit' | 'renewal';
  checkedAt?: number;
  validUntil?: number;
}

// Only fixed labels, generated identifiers and timings cross this logging boundary.
// Never pass headers, tickets, error messages, desktop bytes or upstream stderr here.
export function viewTiming(
  logger: FastifyBaseLogger,
  sessionId: string,
  conversationId: string | undefined,
) {
  const began = performance.now();
  function record(stage: Stage, outcome: Outcome, durationMs = 0, details: Details = {}) {
    const fields = {
      operation: 'view.timing', sessionId, conversationId, stage, outcome,
      durationMs: Math.round(durationMs), elapsedMs: Math.round(performance.now() - began),
      ...details,
    };
    logger.info(fields, 'Live view timing');
  }
  return record;
}
