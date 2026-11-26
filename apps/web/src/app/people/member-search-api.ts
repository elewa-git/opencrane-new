import { memberDirectorySchema } from '@opencrane/protocol';
import { classifyStatus, waitForNextRead, type FailureKind } from './groups-api';

export type MemberDirectory = ReturnType<typeof memberDirectorySchema.parse>;
type DirectoryResult = { kind: 'ok'; value: MemberDirectory }
  | { kind: FailureKind; status: number } | { kind: 'unavailable' };

export async function searchMembers(
  query: string, after: string, signal: AbortSignal,
): Promise<DirectoryResult> {
  const parameters = new URLSearchParams({ q: query.slice(0, 100), after, limit: '20' });
  const url = `/api/members?${parameters.toString()}`;
  try {
    const response = await fetchMemberRead(url, signal);
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

export async function fetchMemberRead(url: string, signal: AbortSignal): Promise<Response> {
  const deadline = AbortSignal.timeout(10_000);
  const readSignal = AbortSignal.any([signal, deadline]);
  const request = { headers: { accept: 'application/json' }, signal: readSignal };
  // Read again only while the server confirms the signed-in person's join is still applying.
  for (let attempt = 0; ; attempt += 1) {
    readSignal.throwIfAborted();
    const response = await fetch(url, request);
    if (response.status !== 425 || attempt === 10) return response;
    await response.body?.cancel();
    await waitForNextRead(readSignal);
  }
}
