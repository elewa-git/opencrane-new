import { z } from 'zod';
import { probeHost } from './host-probe.ts';
import { probeContainer } from './container-probe.ts';
import { probePrivateProcessInventory } from './private-processes.ts';
import type { ProtectionFailure } from './protection-failure.ts';

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

type Refusal = { result: 'FAIL'; reason: 'input_invalid' | 'host_refused' | 'journey_failed';
  protectionFailure?: ProtectionFailure };

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
  const safeHost = probeHost();
  if (!safeHost) {
    const protection = probeContainer();
    if (protection !== true) {
      return { result: 'FAIL', reason: 'host_refused', protectionFailure: protection };
    }
    const inventory = probePrivateProcessInventory();
    if (inventory !== true) {
      return { result: 'FAIL', reason: 'host_refused', protectionFailure: inventory };
    }
  }
  let result: Receipt['result'] = 'NOT RUN';
  if (safeHost && (request.name === 'privateTurns' || request.name === 'nativeRecall')) {
    try {
      const { checkNative } = await import('./native-checks.ts');
      const { checkRecallPrerequisites } = await import('./native-recall-checks.ts');
      if (!probeHost()) {
        return { result: 'FAIL', reason: 'host_refused' };
      }
      if (request.name === 'privateTurns') {
        await checkNative(request.challengeId);
        result = 'PARTIAL';
      } else {
        await checkRecallPrerequisites(request.siloId, request.challengeId);
      }
    } catch {
      const reason = probeHost() ? 'journey_failed' : 'host_refused';
      return { result: 'FAIL', reason };
    }
  }
  if (safeHost && (request.name === 'invalidation' || request.name === 'unrelatedActivity' ||
      request.name === 'requesterIsolation' || request.name === 'sessionIsolation' ||
      request.name === 'stopReconnect' || request.name === 'replacementReload')) {
    try {
      const { checkMemory } = await import('./memory-checks.ts');
      if (!probeHost()) {
        return { result: 'FAIL', reason: 'host_refused' };
      }
      await checkMemory(request.name, request.siloId);
      result = 'PARTIAL';
    } catch {
      const reason = probeHost() ? 'journey_failed' : 'host_refused';
      return { result: 'FAIL', reason };
    }
  }
  if (safeHost) {
    if (!probeHost()) {
      return { result: 'FAIL', reason: 'host_refused' };
    }
  } else {
    const protection = probeContainer();
    if (protection !== true) {
      return { result: 'FAIL', reason: 'host_refused', protectionFailure: protection };
    }
    const inventory = probePrivateProcessInventory();
    if (inventory !== true) {
      return { result: 'FAIL', reason: 'host_refused', protectionFailure: inventory };
    }
  }
  // These assertions cannot qualify isolation, persistence or private output delivery.
  return { ...request, observedAt: Date.now(), result, complete: false };
}
