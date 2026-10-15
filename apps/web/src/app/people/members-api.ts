import { memberAccessSchema, memberDetailSchema, memberHeaderSchema } from '@opencrane/protocol';

export type Header = ReturnType<typeof memberHeaderSchema.parse>;
export type Detail = ReturnType<typeof memberDetailSchema.parse>;
export type Access = ReturnType<typeof memberAccessSchema.parse>;
export type ReadResult<T> = { kind: 'ok'; value: T } | { kind: 'denied'; status: number }
  | { kind: 'missing' | 'failed' };

async function read(url: string, signal: AbortSignal): Promise<ReadResult<unknown>> {
  try {
    const response = await fetch(url, { headers: { accept: 'application/json' }, signal });
    // Check the status before reading a denied body, which may contain no JSON.
    if (response.status === 401 || response.status === 403) {
      return { kind: 'denied', status: response.status };
    }
    if (response.status === 404) return { kind: 'missing' };
    if (!response.ok) return { kind: 'failed' };
    return { kind: 'ok', value: await response.json() as unknown };
  } catch {
    return { kind: 'failed' };
  }
}

export async function fetchMember(
  memberId: string, signal: AbortSignal,
): Promise<ReadResult<Header | Detail>> {
  const result = await read(`/api/members/${encodeURIComponent(memberId)}`, signal);
  if (result.kind !== 'ok') return result;
  const full = memberDetailSchema.safeParse(result.value);
  if (full.success) return { kind: 'ok', value: full.data };
  const header = memberHeaderSchema.safeParse(result.value);
  if (header.success) return { kind: 'ok', value: header.data };
  return { kind: 'failed' };
}

export async function fetchMemberAccess(
  memberId: string, signal: AbortSignal,
): Promise<ReadResult<Access>> {
  const result = await read(`/api/members/${encodeURIComponent(memberId)}/access`, signal);
  if (result.kind !== 'ok') return result;
  const parsed = memberAccessSchema.safeParse(result.value);
  if (!parsed.success) return { kind: 'failed' };
  return { kind: 'ok', value: parsed.data };
}
