import { memberDirectorySchema } from '@opencrane/protocol';
import { classifyStatus, type Outcome } from './groups-api';

export type MemberDirectory = ReturnType<typeof memberDirectorySchema.parse>;

export async function searchMembers(
  query: string, after: string, signal: AbortSignal,
): Promise<Outcome<MemberDirectory>> {
  const parameters = new URLSearchParams({ q: query.slice(0, 100), after, limit: '20' });
  try {
    const response = await fetch(`/api/members?${parameters.toString()}`, {
      headers: { accept: 'application/json' }, signal,
    });
    if (!response.ok) {
      return { kind: classifyStatus(response.status, 'GET'), status: response.status };
    }
    const raw: unknown = await response.json();
    const parsed = memberDirectorySchema.safeParse(raw);
    if (!parsed.success) return { kind: 'unavailable' };
    return { kind: 'ok', value: parsed.data };
  } catch {
    return { kind: 'unavailable' };
  }
}
