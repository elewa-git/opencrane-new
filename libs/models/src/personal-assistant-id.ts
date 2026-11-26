import { sha256Hex } from '@opencrane/events/digest';

export function personalAssistantId(silo: string, memberId: string) {
  const identity = [silo, memberId].join('\0');
  const digest = sha256Hex(identity);
  const suffix = digest.slice(0, 32);
  return `personal-${suffix}`;
}
