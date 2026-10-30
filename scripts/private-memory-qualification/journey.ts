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

type Refusal = { result: 'FAIL'; reason: 'input_invalid' | 'host_refused' | 'journey_failed' };

type Request = z.infer<typeof requestSchema>;
type Receipt = Request & { observedAt: number; result: 'NOT RUN' | 'PARTIAL'; complete: false };

export async function runJourney(input: string): Promise<Refusal | Receipt> {
  let request: Request;
  try {
    if (Buffer.byteLength(input) > 4096) {
      return { result: 'FAIL', reason: 'input_invalid' };
    }
    request = requestSchema.parse(JSON.parse(input));
  } catch {
    return { result: 'FAIL', reason: 'input_invalid' };
  }
  if (!probeHost()) {
    return { result: 'FAIL', reason: 'host_refused' };
  }
  let result: Receipt['result'] = 'NOT RUN';
  if (request.name === 'invalidation' || request.name === 'unrelatedActivity') {
    try {
      const { checkMemory } = await import('./memory-checks.ts');
      await checkMemory(request.name, request.siloId);
      result = 'PARTIAL';
    } catch {
      return { result: 'FAIL', reason: 'journey_failed' };
    }
  }
  // Server assertions alone cannot qualify native processes or private output delivery.
  return { ...request, observedAt: Date.now(), result, complete: false };
}
