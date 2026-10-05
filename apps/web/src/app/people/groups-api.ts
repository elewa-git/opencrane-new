import {
  createGroupCommandSchema, groupChangeSchema, groupReceiptSchema, groupsResponseSchema,
  type GroupRow,
} from '@opencrane/protocol';

export type FailureKind = 'access_changed' | 'refused' | 'invalid' | 'conflict'
  | 'not_found' | 'unavailable';
export type Outcome<T> = { kind: 'ok'; value: T }
  | { kind: FailureKind; status?: number };
export type ChangeCheck = { kind: 'current'; checkedAt: string }
  | { kind: 'still_applying' | 'not_found' | 'unavailable' }
  | { kind: 'access_changed'; status?: number };

export function classifyStatus(status: number, method: 'GET' | 'POST'): FailureKind {
  if (status === 401 || (status === 403 && method === 'GET')) return 'access_changed';
  if (status === 403) return 'refused';
  if (status === 400) return 'invalid';
  if (status === 409) return 'conflict';
  if (status === 404) return 'not_found';
  return 'unavailable';
}

export async function fetchGroups(signal: AbortSignal): Promise<Outcome<GroupRow[]>> {
  return readRows('/api/groups', signal, false);
}

export async function fetchGroup(
  groupId: string, signal: AbortSignal,
): Promise<Outcome<GroupRow | undefined>> {
  return readRows(`/api/groups/${encodeURIComponent(groupId)}`, signal, true);
}

function readRows(url: string, signal: AbortSignal, single: false): Promise<Outcome<GroupRow[]>>;
function readRows(url: string, signal: AbortSignal, single: true): Promise<Outcome<GroupRow | undefined>>;
async function readRows(
  url: string, signal: AbortSignal, single: boolean,
): Promise<Outcome<GroupRow[] | GroupRow | undefined>> {
  try {
    const response = await fetch(url, { headers: { accept: 'application/json' }, signal });
    if (!response.ok) return { kind: classifyStatus(response.status, 'GET'), status: response.status };
    const raw: unknown = await response.json();
    const result = groupsResponseSchema.safeParse(raw);
    if (!result.success || (single && result.data.rows.length > 1)) {
      return { kind: 'unavailable' };
    }
    if (single) return { kind: 'ok', value: result.data.rows[0] };
    return { kind: 'ok', value: result.data.rows };
  } catch {
    if (signal.aborted) return { kind: 'unavailable' };
    return { kind: 'unavailable' };
  }
}

export async function sendCreateGroup(
  body: unknown, signal: AbortSignal,
): Promise<Outcome<ReturnType<typeof groupReceiptSchema.parse>>> {
  const command = createGroupCommandSchema.safeParse(body);
  if (!command.success) return { kind: 'invalid' };
  return sendPost('/api/groups', command.data, signal);
}

async function sendPost(
  url: string, body: unknown, signal: AbortSignal,
): Promise<Outcome<ReturnType<typeof groupReceiptSchema.parse>>> {
  try {
    const response = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal,
    });
    if (!response.ok) return { kind: classifyStatus(response.status, 'POST'), status: response.status };
    const raw: unknown = await response.json();
    const result = groupReceiptSchema.safeParse(raw);
    if (!result.success) return { kind: 'unavailable' };
    return { kind: 'ok', value: result.data };
  } catch {
    return { kind: 'unavailable' };
  }
}

export async function fetchChange(
  groupId: string, commandId: string, signal: AbortSignal,
): Promise<Outcome<ReturnType<typeof groupChangeSchema.parse>>> {
  try {
    const url = `/api/groups/${encodeURIComponent(groupId)}/changes/${encodeURIComponent(commandId)}`;
    const response = await fetch(url, { headers: { accept: 'application/json' }, signal });
    if (!response.ok) return { kind: classifyStatus(response.status, 'GET'), status: response.status };
    const raw: unknown = await response.json();
    const result = groupChangeSchema.safeParse(raw);
    if (!result.success) return { kind: 'unavailable' };
    return { kind: 'ok', value: result.data };
  } catch {
    return { kind: 'unavailable' };
  }
}

export async function followChange(
  groupId: string, commandId: string, signal: AbortSignal,
): Promise<ChangeCheck> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (signal.aborted) return { kind: 'unavailable' };
    const result = await fetchChange(groupId, commandId, signal);
    if (signal.aborted) return { kind: 'unavailable' };
    // Keep a missing receipt uncertain: a delayed command can still reach the server.
    if (result.kind !== 'ok') {
      if (result.kind === 'access_changed') {
        if (result.status === undefined) return { kind: result.kind };
        return { kind: result.kind, status: result.status };
      }
      if (result.kind === 'not_found') {
        return { kind: result.kind };
      }
      return { kind: 'unavailable' };
    }
    const change = result.value;
    if (change.projection.content === 'current' && change.projection.iam === 'current') {
      return { kind: 'current', checkedAt: new Date().toISOString() };
    }
    if (attempt < 19) {
      await waitForNextRead(signal);
    }
  }
  return { kind: 'still_applying' };
}

function waitForNextRead(signal: AbortSignal): Promise<void> {
  return new Promise<void>(scheduleNextRead.bind(null, signal));
}

function scheduleNextRead(signal: AbortSignal, resolve: () => void): void {
  const timer = globalThis.setTimeout(resolve, 500);
  signal.addEventListener('abort', cancelWait.bind(null, timer, resolve), { once: true });
}

function cancelWait(timer: number, resolve: () => void): void {
  globalThis.clearTimeout(timer);
  resolve();
}
