import { memberDirectorySchema } from '@opencrane/protocol';
import { z } from 'zod';
import { retryRead } from '../core/read-retry';
import { classifyStatus, type FailureKind } from './groups-api';

export type MemberDirectory = ReturnType<typeof memberDirectorySchema.parse>;
const accessApplying = z.strictObject({ status: z.literal('access_applying') });

type DirectoryResult = { kind: 'ok'; value: MemberDirectory }
  | { kind: FailureKind; status: number } | { kind: 'unavailable' | 'access_applying' };

export async function searchMembers(
  query: string, after: string, signal: AbortSignal, onApplying?: () => void,
): Promise<DirectoryResult> {
  const parameters = new URLSearchParams({ q: query.slice(0, 100), after, limit: '20' });
  let applyingReply: Response | undefined;
  function url() {
    return `/api/members?${parameters.toString()}`;
  }
  function noteApplying(response: Response) {
    applyingReply = response;
    // Start over because the cursor may be from the previous account.
    if (onApplying) {
      parameters.set('after', '');
      onApplying();
    }
  }
  try {
    const response = await fetchMemberRead(url, signal, noteApplying);
    if (response === applyingReply) {
      return { kind: 'access_applying' };
    }
    if (!response.ok) {
      return { kind: classifyStatus(response.status, 'GET'), status: response.status };
    }
    const raw: unknown = await response.json();
    const parsed = memberDirectorySchema.safeParse(raw);
    if (!parsed.success) return { kind: 'unavailable' };
    return { kind: 'ok', value: parsed.data };
  } catch (error) {
    if (applyingReply && !signal.aborted && error instanceof DOMException
      && error.name === 'TimeoutError') {
      return { kind: 'access_applying' };
    }
    return { kind: 'unavailable' };
  }
}

export function fetchMemberRead(url: () => string, signal: AbortSignal,
  onApplying?: (response: Response) => void) {
  function readAttempt(readSignal: AbortSignal) {
    const request = { headers: { accept: 'application/json' }, signal: readSignal };
    return fetch(url(), request);
  }

  function shouldRetry(response: Response) {
    if (response.status !== 425) {
      return false;
    }
    return readApplyingReply(response);
  }

  async function readApplyingReply(response: Response) {
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      // Ignore non-JSON intermediary replies and let cancellation or transport errors end the read.
      if (error instanceof SyntaxError) {
        return false;
      }
      throw error;
    }
    if (!accessApplying.safeParse(body).success) {
      return false;
    }
    onApplying?.(response);
    return true;
  }

  const retry = { attempts: 11, delayMs: 500, shouldRetry };
  return retryRead(readAttempt, signal, retry);
}
