import { memberAccessSchema, memberDepartureSchema, memberDetailSchema,
  memberHeaderSchema, memberRoleCommandSchema, memberRoleReceiptSchema,
  memberRoleStatusSchema } from '@opencrane/protocol';
import { z } from 'zod';

export type Header = ReturnType<typeof memberHeaderSchema.parse>;
export type Detail = ReturnType<typeof memberDetailSchema.parse>;
export type Access = ReturnType<typeof memberAccessSchema.parse>;
export type Departure = ReturnType<typeof memberDepartureSchema.parse>;
export type RoleReceipt = ReturnType<typeof memberRoleReceiptSchema.parse>;
export type RoleStatus = ReturnType<typeof memberRoleStatusSchema.parse>;
export type ReadResult<T> = { kind: 'ok'; value: T } | { kind: 'denied'; status: number }
  | { kind: 'missing' | 'failed' };
export type RoleResult<T> = ReadResult<T> | { kind: 'invalid' }
  | { kind: 'conflict'; reason: string };

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

export async function fetchDeparture(
  memberId: string, signal: AbortSignal,
): Promise<ReadResult<Departure>> {
  const result = await read(`/api/members/${encodeURIComponent(memberId)}/departure`, signal);
  if (result.kind !== 'ok') return result;
  const parsed = memberDepartureSchema.safeParse(result.value);
  if (!parsed.success) return { kind: 'failed' };
  return { kind: 'ok', value: parsed.data };
}

const removalReceiptSchema = z.object({
  status: z.literal('recorded'), removedAt: z.iso.datetime(), access: z.literal('revoked'),
  projection: z.object({ iam: z.enum(['applying', 'current']),
    content: z.enum(['applying', 'current']) }).optional(),
});
export type RemovalReceipt = z.infer<typeof removalReceiptSchema>;
export type RemovalResult = ReadResult<RemovalReceipt> | { kind: 'conflict'; reason: string };

async function removalReply(response: Response): Promise<RemovalResult> {
  if (response.status === 401 || response.status === 403) {
    return { kind: 'denied', status: response.status };
  }
  if (response.status === 404) return { kind: 'missing' };
  if (response.status === 409) {
    const raw: unknown = await response.json();
    const parsed = z.object({ reason: z.string().optional() }).safeParse(raw);
    return { kind: 'conflict', reason: parsed.success ? parsed.data.reason ?? '' : '' };
  }
  if (!response.ok) return { kind: 'failed' };
  const raw: unknown = await response.json();
  const parsed = removalReceiptSchema.safeParse(raw);
  if (!parsed.success) return { kind: 'failed' };
  return { kind: 'ok', value: parsed.data };
}

export async function sendMemberRemoval(memberId: string, body: {
  commandId: string; expectedSequence: number; reviewRevision: string,
}, signal: AbortSignal): Promise<RemovalResult> {
  try {
    const response = await fetch(`/api/members/${encodeURIComponent(memberId)}/remove`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal,
    });
    return await removalReply(response);
  } catch { return { kind: 'failed' }; }
}

export async function fetchRemovalStatus(memberId: string, commandId: string,
  signal: AbortSignal): Promise<RemovalResult> {
  try {
    const path = `/api/members/${encodeURIComponent(memberId)}/changes/`;
    const response = await fetch(path + encodeURIComponent(commandId), { signal });
    return await removalReply(response);
  } catch { return { kind: 'failed' }; }
}

async function roleReply<T>(response: Response,
  schema: typeof memberRoleReceiptSchema | typeof memberRoleStatusSchema,
): Promise<RoleResult<T>> {
  if (response.status === 401 || response.status === 403) {
    return { kind: 'denied', status: response.status };
  }
  if (response.status === 404) return { kind: 'missing' };
  if (response.status === 400) return { kind: 'invalid' };
  if (response.status === 409) {
    try {
      const raw: unknown = await response.json();
      const parsed = z.object({ reason: z.string().optional() }).safeParse(raw);
      return { kind: 'conflict', reason: parsed.success ? parsed.data.reason ?? '' : '' };
    } catch { return { kind: 'conflict', reason: '' }; }
  }
  if (!response.ok) return { kind: 'failed' };
  try {
    const raw: unknown = await response.json();
    const parsed = schema.safeParse(raw);
    if (!parsed.success) return { kind: 'failed' };
    return { kind: 'ok', value: parsed.data as T };
  } catch { return { kind: 'failed' }; }
}

export async function sendMemberRole(memberId: string, body: unknown,
  signal: AbortSignal): Promise<RoleResult<RoleReceipt>> {
  const command = memberRoleCommandSchema.safeParse(body);
  if (!command.success) return { kind: 'invalid' };
  try {
    const response = await fetch(`/api/members/${encodeURIComponent(memberId)}/role`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(command.data), signal,
    });
    return await roleReply(response, memberRoleReceiptSchema);
  } catch { return { kind: 'failed' }; }
}

export async function fetchMemberRoleStatus(memberId: string, commandId: string,
  signal: AbortSignal): Promise<RoleResult<RoleStatus>> {
  try {
    const path = `/api/members/${encodeURIComponent(memberId)}/changes/`;
    const response = await fetch(path + encodeURIComponent(commandId), { signal });
    return await roleReply(response, memberRoleStatusSchema);
  } catch { return { kind: 'failed' }; }
}
