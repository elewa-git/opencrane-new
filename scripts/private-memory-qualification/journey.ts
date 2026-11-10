import { z } from 'zod';
import { writeFileSync } from 'node:fs';
import { probeHost } from './host-probe.ts';
import { probeContainer } from './container-probe.ts';
import { probePrivateProcessInventory } from './private-processes.ts';
import { startServiceProtection } from './service-protection.ts';
import {
  proveCanaryHelper, readCanaryHelperBinding, type CanaryHelperBinding,
} from './canary-helper-proof.ts';
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

type Refusal =
  { result: 'FAIL'; reason: 'input_invalid' | 'host_refused' | 'journey_failed' } |
  { result: 'FAIL'; reason: 'host_refused';
    protectionFailure: Exclude<ProtectionFailure, 'private_process_missing'> } |
  { result: 'FAIL'; reason: 'host_refused';
    protectionFailure: ProtectionFailure; complete: false };

type Request = z.infer<typeof requestSchema>;
type Receipt = Request & { observedAt: number; result: 'NOT RUN' | 'PARTIAL'; complete: false };

function containerRefusal(protectionFailure: ProtectionFailure): Refusal {
  if (protectionFailure === 'private_process_missing') {
    return { result: 'FAIL', reason: 'host_refused', protectionFailure, complete: false };
  }
  return { result: 'FAIL', reason: 'host_refused', protectionFailure };
}

function checkCanaryHelper(binding: CanaryHelperBinding,
  request: Request): true | ProtectionFailure {
  function currentInstallation(): { imageDigest: string; installationId: string } {
    const current = readCanaryHelperBinding(request);
    return { imageDigest: current.imageDigest, installationId: current.installationId };
  }
  return proveCanaryHelper(binding, currentInstallation);
}

async function holdForInventory(challengeId: string, stage: 'ready' | 'workDone'):
  Promise<void> {
  if (process.env['OPENCRANE_INVENTORY_HOLD'] !== '1') {
    return;
  }
  const path = '/run/opencrane-memory-qualification.lock/inventory-stage';
  const flag = stage === 'ready' ? 'wx' : 'w';
  await new Promise<void>(function pause(resolve): void {
    process.once('SIGUSR2', resolve);
    writeFileSync(path, `${challengeId} ${stage}\n`, { flag, mode: 0o600 });
  });
}

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
  let helperBinding: CanaryHelperBinding;
  try {
    helperBinding = readCanaryHelperBinding(request);
  } catch {
    return { result: 'FAIL', reason: 'host_refused',
      protectionFailure: 'private_process_unreadable', complete: false };
  }
  const helperBefore = checkCanaryHelper(helperBinding, request);
  if (helperBefore !== true) {
    return { result: 'FAIL', reason: 'host_refused', protectionFailure: helperBefore,
      complete: false };
  }
  const closeProtection = await startServiceProtection('canaryHelper');
  try {
    return await runProtectedJourney(request, helperBinding);
  } finally {
    await closeProtection();
  }
}

async function runProtectedJourney(request: Request,
  helperBinding: CanaryHelperBinding): Promise<Refusal | Receipt> {
  await holdForInventory(request.challengeId, 'ready');
  function finish(result: Refusal | Receipt): Refusal | Receipt {
    const helperAfter = checkCanaryHelper(helperBinding, request);
    if (helperAfter !== true) {
      return { result: 'FAIL', reason: 'host_refused', protectionFailure: helperAfter,
        complete: false };
    }
    return result;
  }
  const safeHost = probeHost();
  if (!safeHost) {
    const protection = probeContainer();
    if (protection !== true) {
      return finish(containerRefusal(protection));
    }
    const inventory = probePrivateProcessInventory();
    if (inventory !== true) {
      return finish({ result: 'FAIL', reason: 'host_refused', protectionFailure: inventory,
        complete: false });
    }
  }
  let result: Receipt['result'] = 'NOT RUN';
  if (safeHost && (request.name === 'privateTurns' || request.name === 'nativeRecall')) {
    try {
      const { checkNative } = await import('./native-checks.ts');
      const { checkRecallPrerequisites } = await import('./native-recall-checks.ts');
      if (!probeHost()) {
        return finish({ result: 'FAIL', reason: 'host_refused' });
      }
      if (request.name === 'privateTurns') {
        await checkNative(request.challengeId);
        result = 'PARTIAL';
      } else {
        await checkRecallPrerequisites(request.siloId, request.challengeId);
      }
    } catch {
      const reason = probeHost() ? 'journey_failed' : 'host_refused';
      return finish({ result: 'FAIL', reason });
    }
  }
  if (safeHost && (request.name === 'invalidation' || request.name === 'unrelatedActivity' ||
      request.name === 'requesterIsolation' || request.name === 'sessionIsolation' ||
      request.name === 'stopReconnect' || request.name === 'replacementReload')) {
    try {
      const { checkMemory } = await import('./memory-checks.ts');
      if (!probeHost()) {
        return finish({ result: 'FAIL', reason: 'host_refused' });
      }
      await checkMemory(request.name, request.siloId);
      result = 'PARTIAL';
    } catch {
      const reason = probeHost() ? 'journey_failed' : 'host_refused';
      return finish({ result: 'FAIL', reason });
    }
  }
  if (safeHost) {
    if (!probeHost()) {
      return finish({ result: 'FAIL', reason: 'host_refused' });
    }
  } else {
    const protection = probeContainer();
    if (protection !== true) {
      return finish(containerRefusal(protection));
    }
    const inventory = probePrivateProcessInventory();
    if (inventory !== true) {
      return finish({ result: 'FAIL', reason: 'host_refused', protectionFailure: inventory,
        complete: false });
    }
  }
  // These assertions cannot qualify isolation, persistence or private output delivery.
  await holdForInventory(request.challengeId, 'workDone');
  return finish({ ...request, observedAt: Date.now(), result, complete: false });
}
