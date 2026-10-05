import type { Page, Response, WebSocket } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';
import { directory } from './config.ts';

// Rebuild an allowlisted record instead of copying arbitrary server log fields.
// Session identifiers correlate requests without retaining tickets or cookies.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function collectViewTimings(sessionId: string, output: string) {
  const contents = await readFile(`${directory}/server.log`, 'utf8');
  const records: Record<string, unknown>[] = [];
  const fields = ['time', 'sessionId', 'stage', 'outcome', 'durationMs',
    'elapsedMs', 'phase', 'checkedAtMonotonic', 'validUntil', 'boundary'];
  for (const line of contents.split('\n')) {
    if (!line.startsWith('{')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    if (parsed['operation'] !== 'view.timing' || parsed['sessionId'] !== sessionId) continue;
    const record: Record<string, unknown> = {};
    for (const field of fields) {
      const item = parsed[field];
      if (typeof item === 'string' || typeof item === 'number') record[field] = item;
    }
    records.push(record);
  }
  function serialise(record: Record<string, unknown>) {
    return JSON.stringify(record);
  }
  const lines = records.map(serialise);
  const contentsToWrite = lines.length > 0 ? `${lines.join('\n')}\n` : '';
  await writeFile(output, contentsToWrite);
  return records;
}


export function browserViewTimings(page: Page, conversationId: string) {
  const began = performance.now();
  const records: { stage: string; elapsedMs: number; status?: number; sessionId?: string }[] = [];
  const cleanups: (() => void)[] = [];
  function record(stage: string, status?: number) {
    const entry = {
      stage, elapsedMs: Math.round(performance.now() - began),
      ...(status === undefined ? {} : { status }),
    };
    records.push(entry);
  }
  function response(reply: Response) {
    const path = new URL(reply.url()).pathname;
    if (path === `/api/conversations/${conversationId}/view`) {
      void recordAdmission(reply);
    }
  }
  async function recordAdmission(reply: Response) {
    const entry = {
      stage: 'admission_response',
      elapsedMs: Math.round(performance.now() - began),
      status: reply.status(),
    };
    try {
      const value: unknown = await reply.json();
      if (isRecord(value) && typeof value['sessionId'] === 'string') {
        records.push({ ...entry, sessionId: value['sessionId'] });
        return;
      }
    } catch {
      // Refused admissions do not return an admitted session identifier.
    }
    records.push(entry);
  }
  function socketOpened(socket: WebSocket) {
    if (new URL(socket.url()).pathname !== `/ws/conversations/${conversationId}/view`) return;
    record('browser_socket_created');
    function firstBytes() {
      record('browser_first_bytes');
    }
    function closed() {
      record('browser_socket_closed');
    }
    function error() {
      record('browser_socket_error');
    }
    socket.once('framereceived', firstBytes);
    socket.once('close', closed);
    socket.once('socketerror', error);
    function cleanup() {
      socket.off('framereceived', firstBytes);
      socket.off('close', closed);
      socket.off('socketerror', error);
    }
    cleanups.push(cleanup);
  }
  page.on('response', response);
  page.on('websocket', socketOpened);
  function stop() {
    page.off('response', response);
    page.off('websocket', socketOpened);
    for (const cleanup of cleanups) cleanup();
    return records;
  }
  return stop;
}
