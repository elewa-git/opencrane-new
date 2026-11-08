import type { ProtectionFailure } from './protection-failure.ts';

export function checkSupervisor(): { result: true | ProtectionFailure;
  pid?: number; startTime?: string } {
  return { result: 'private_process_missing' };
}
