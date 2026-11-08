import { proveComputerService } from './bridge-proof.ts';
import type { ProtectionFailure } from './protection-failure.ts';

// Measure the proxy in the bridge process only while it holds a private tool call.
export function proveComputerProxy(containerId: string,
  installationId: string, expectedImage: string): Promise<true | ProtectionFailure> {
  return proveComputerService(containerId, installationId, 'proxy', expectedImage);
}
