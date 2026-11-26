import type { Request, Response, WebSocket } from 'playwright';
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


type Listen = {
  (event: 'request', listener: (request: Request) => void): void;
  (event: 'response', listener: (response: Response) => void): void;
  (event: 'websocket', listener: (socket: WebSocket) => void): void;
};

export interface BrowserObservation {
  on: Listen;
  off: Listen;
}

export interface BrowserViewTiming {
  conversationId: string;
  stage: string;
  elapsedMs: number;
  status?: number;
  sessionId?: string;
}

export function browserViewTimings(page: BrowserObservation) {
  const began = performance.now();
  const records: BrowserViewTiming[] = [];
  const cleanups: (() => void)[] = [];
  function response(reply: Response) {
    const path = new URL(reply.url()).pathname;
    const conversationId = /^\/api\/conversations\/([\w-]+)\/view$/u.exec(path)?.[1];
    if (conversationId) void recordAdmission(reply, conversationId);
  }
  async function recordAdmission(reply: Response, conversationId: string) {
    const entry = {
      conversationId, stage: 'admission_response',
      elapsedMs: Math.round(performance.now() - began), status: reply.status(),
    };
    try {
      const value: unknown = await reply.json();
      if (isRecord(value) && typeof value['sessionId'] === 'string') {
        records.push({ ...entry, sessionId: value['sessionId'] });
        return;
      }
    } catch {
      // Keep the HTTP status when a refusal has no JSON body.
    }
    records.push(entry);
  }
  function socketOpened(socket: WebSocket) {
    const path = new URL(socket.url()).pathname;
    const conversationId = /^\/ws\/conversations\/([\w-]+)\/view$/u.exec(path)?.[1];
    if (!conversationId) return;
    const chat = conversationId;
    function record(stage: string) {
      const elapsedMs = Math.round(performance.now() - began);
      records.push({ conversationId: chat, stage, elapsedMs });
    }
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
