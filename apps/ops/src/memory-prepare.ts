import type { EventEnvelope } from '@opencrane/events';
import { memoryMaintenanceRecordedDataSchema } from '@opencrane/events';
import { registerHandler } from '@opencrane/handlers';

export function memoryPrepareHandler(decisionUrl: string) {
  async function prepare(event: EventEnvelope) {
    if (event.type !== 'memory.maintenance_recorded' ||
        event.source !== 'opencrane-nightly') {
      return;
    }
    const run = memoryMaintenanceRecordedDataSchema.parse(event.data);
    if (run.action !== 'due' && run.reason !== 'qualification_blocked') {
      return;
    }
    const request = { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scopeId: run.scopeId, nightId: run.nightId }),
      signal: AbortSignal.timeout(10_000) };
    const response = await fetch(`${decisionUrl}/maintenance/prepare`, request);
    if (!response.ok) throw new Error('Nightly memory preparation unavailable');
  }
  return registerHandler('dream-memory', prepare);
}
