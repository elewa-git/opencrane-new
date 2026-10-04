import type { FastifyBaseLogger } from 'fastify';

export type DesktopTiming = (
  stage: 'pod_lookup',
  outcome: 'started' | 'ok' | 'error',
  durationMs: number,
) => void;

type Stage = 'ticket_issue' | 'websocket_upgrade' | 'start_audit' | 'upstream_open'
  | 'pod_lookup' | 'first_upstream_bytes' | 'first_browser_frame'
  | 'lease_check' | 'lease_pause' | 'lease_resume' | 'stop';
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
) {
  const began = performance.now();
  function record(stage: Stage, outcome: Outcome, durationMs = 0, details: Details = {}) {
    const fields = {
      operation: 'view.timing', sessionId, stage, outcome,
      durationMs: Math.round(durationMs), elapsedMs: Math.round(performance.now() - began),
      ...details,
    };
    if (stage === 'lease_check' && outcome === 'ok' && durationMs < 250 &&
      details.phase === 'renewal') {
      logger.debug(fields, 'Live view timing');
      return;
    }
    logger.info(fields, 'Live view timing');
  }
  return record;
}

export async function timeStage<T>(
  work: () => Promise<T>,
  started: (() => void) | undefined,
  succeeded: (durationMs: number) => void,
  failed: (error: unknown, durationMs: number) => void,
): Promise<T> {
  const startedAt = performance.now();
  started?.();
  try {
    const result = await work();
    succeeded(performance.now() - startedAt);
    return result;
  } catch (error) {
    failed(error, performance.now() - startedAt);
    throw error;
  }
}
