import {
  ownershipChangeSchema,
  ownershipCommandSchema,
  ownershipResponseSchema,
  type OwnershipChange,
  type OwnershipResponse,
} from '@opencrane/protocol';

type OwnershipFailure = 'access_changed' | 'refused' | 'invalid' | 'conflict'
  | 'not_found' | 'unavailable';
export type OwnershipOutcome<T> = { kind: 'ok'; value: T }
  | { kind: OwnershipFailure };

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

function conflictFrom(_response: Response): Promise<OwnershipOutcome<never>> {
  return Promise.resolve({ kind: 'conflict' });
}

function refusalFrom(_response: Response): Promise<OwnershipOutcome<never>> {
  return Promise.resolve({ kind: 'refused' });
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
