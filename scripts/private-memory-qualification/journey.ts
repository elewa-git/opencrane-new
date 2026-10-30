import { z } from 'zod';
import { probeHost } from './host-probe.ts';

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const requestSchema = z.strictObject({
  sourceSha: z.string().regex(/^[a-f0-9]{40}$/u), imageDigest: digest,
  environmentId: z.string().regex(/^[a-f0-9]{64}$/u), siloId: digest,
  installationId: digest, runId: z.uuid(), freshInstall: z.literal(true),
  challengeId: z.uuid(),
  name: z.enum(['privateTurns', 'nativeRecall', 'requesterIsolation', 'sessionIsolation',
    'invalidation', 'unrelatedActivity', 'stopReconnect', 'replacementReload', 'persistence',
    'P4-14', 'P4-15']),
});

type Refusal = { result: 'FAIL'; reason: 'input_invalid' | 'host_refused' | 'journey_incomplete' };

export function runJourney(input: string): Refusal {
  try {
    if (Buffer.byteLength(input) > 4096) {
      return { result: 'FAIL', reason: 'input_invalid' };
    }
    requestSchema.parse(JSON.parse(input));
  } catch {
    return { result: 'FAIL', reason: 'input_invalid' };
  }
  if (!probeHost()) {
    return { result: 'FAIL', reason: 'host_refused' };
  }
  // Keep all journeys refused until native, process and persistence assertions exist.
  return { result: 'FAIL', reason: 'journey_incomplete' };
}
