import type { ProtectionFailure } from './protection-failure.ts';

export async function proveComputerSupervisor(_containerId: string,
  _installationId: string): Promise<true | ProtectionFailure> {
  return 'private_process_missing';
}
