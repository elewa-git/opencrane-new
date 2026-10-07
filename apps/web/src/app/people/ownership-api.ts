import {
  ownershipChangeSchema,
  ownershipCommandSchema,
  ownershipResponseSchema,
  type OwnershipChange,
  type OwnershipResponse,
} from '@opencrane/protocol';

type OwnershipFailure = 'access_changed' | 'refused' | 'invalid' | 'conflict'
  | 'last_owner' | 'not_found' | 'unavailable';
export type OwnershipOutcome<T> = { kind: 'ok'; value: T }
  | { kind: OwnershipFailure; reason?: string };

export async function fetchOwnership(signal: AbortSignal): Promise<OwnershipOutcome<OwnershipResponse>> {
  try {
    const response = await fetch('/api/ownership', {
      headers: { accept: 'application/json' },
      signal,
    });
    if (!response.ok) return { kind: readFailure(response.status) };
    const raw: unknown = await response.json();
    const result = ownershipResponseSchema.safeParse(raw);
    if (!result.success) return { kind: 'unavailable' };
    return { kind: 'ok', value: result.data };
  } catch {
    return { kind: 'unavailable' };
  }
}

export async function sendOwnershipCommand(
  raw: unknown,
  signal: AbortSignal,
): Promise<OwnershipOutcome<OwnershipChange>> {
  const command = ownershipCommandSchema.safeParse(raw);
  if (!command.success) return { kind: 'invalid' };
  try {
    const response = await fetch('/api/ownership', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(command.data),
      signal,
    });
    if (response.status === 401) return { kind: 'access_changed' };
    if (response.status === 400) return { kind: 'invalid' };
    if (response.status === 403) return await refusalFrom(response);
    if (response.status === 409) return await conflictFrom(response);
    if (!response.ok) return { kind: 'unavailable' };
    const rawReceipt: unknown = await response.json();
    const receipt = ownershipChangeSchema.safeParse(rawReceipt);
    if (!receipt.success) return { kind: 'unavailable' };
    return { kind: 'ok', value: receipt.data };
  } catch {
    return { kind: 'unavailable' };
  }
}

async function conflictFrom(response: Response): Promise<OwnershipOutcome<never>> {
  const reason = await responseReason(response);
  if (reason === 'last_owner') return { kind: 'last_owner', reason };
  if (reason) return { kind: 'conflict', reason };
  return { kind: 'conflict' };
}

async function refusalFrom(response: Response): Promise<OwnershipOutcome<never>> {
  const reason = await responseReason(response);
  if (reason) return { kind: 'refused', reason };
  return { kind: 'refused' };
}

async function responseReason(response: Response): Promise<string | undefined> {
  try {
    const raw: unknown = await response.json();
    if (typeof raw !== 'object' || raw === null || !('reason' in raw) ||
        typeof raw.reason !== 'string') return undefined;
    return raw.reason;
  } catch {
    return undefined;
  }
}

function readFailure(status: number): OwnershipFailure {
  if (status === 401 || status === 403) return 'access_changed';
  if (status === 404) return 'not_found';
  return 'unavailable';
}

export async function fetchOwnershipChange(
  commandId: string,
  signal: AbortSignal,
): Promise<OwnershipOutcome<OwnershipChange>> {
  try {
    const url = `/api/ownership/changes/${encodeURIComponent(commandId)}`;
    const response = await fetch(url, { headers: { accept: 'application/json' }, signal });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return { kind: 'access_changed' };
      }
      if (response.status === 404) return { kind: 'not_found' };
      return { kind: 'unavailable' };
    }
    const raw: unknown = await response.json();
    const change = ownershipChangeSchema.safeParse(raw);
    if (!change.success) return { kind: 'unavailable' };
    return { kind: 'ok', value: change.data };
  } catch {
    return { kind: 'unavailable' };
  }
}
