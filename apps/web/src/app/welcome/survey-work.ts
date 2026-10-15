import { chatGroupsSchema } from '@opencrane/protocol';
import { z } from 'zod';

export const savedWork = z.object({
  step: z.literal(2), workDescription: z.string(), groupIds: z.array(z.string()),
});
export type WorkAnswers = z.infer<typeof savedWork>;
export type GroupRow = { groupId: string; name: string };
export function groupIdFromRow(row: GroupRow): string {
  return row.groupId;
}
export type GroupsResult =
  | { kind: 'ready'; rows: GroupRow[]; hasMore: boolean }
  | { kind: 'refused'; status: 401 | 403 }
  | { kind: 'failed' };

export async function readCurrentGroups(request: AbortController): Promise<GroupsResult> {
  try {
    const response = await fetch('/api/chat/groups?limit=16', {
      cache: 'no-store', signal: request.signal,
    });
    if (response.status === 401 || response.status === 403) {
      return { kind: 'refused', status: response.status };
    }
    if (!response.ok) return { kind: 'failed' };
    const parsed = chatGroupsSchema.parse(await response.json());
    if (parsed.rows.length > 16) return { kind: 'failed' };
    return { kind: 'ready', rows: parsed.rows, hasMore: parsed.next !== null };
  } catch {
    return { kind: 'failed' };
  }
}

export function checkedWorkDescription(value: string): string | null {
  const trimmed = value.trim();
  const encoded = new TextEncoder().encode(trimmed);
  const decoded = new TextDecoder('utf-8', { ignoreBOM: true }).decode(encoded);
  if (encoded.byteLength < 1 || encoded.byteLength > 4096 || decoded !== trimmed) return null;
  for (const character of trimmed) {
    const code = character.charCodeAt(0);
    if (code < 32 && code !== 9 && code !== 10) return null;
  }
  return trimmed;
}

export function sameWorkAnswers(saved: WorkAnswers, current: WorkAnswers): boolean {
  if (saved.workDescription !== current.workDescription) return false;
  return sameGroupIds(saved.groupIds, current.groupIds);
}

export function sameGroupIds(savedIds: string[], currentIds: string[]): boolean {
  if (savedIds.length !== currentIds.length) return false;
  const oldIds = new Set(savedIds);
  for (const groupId of currentIds) {
    if (!oldIds.has(groupId)) return false;
  }
  return true;
}
