import { record as asRecord } from './record.ts';
import type { LogDestination } from '../src/logger.ts';

/** An in-memory log destination that keeps every line written to it, so a test can read back the JSON pino actually produced. */
export function memorySink(): { stream: LogDestination; text: () => string; lines: () => Record<string, unknown>[] } {
  const chunks: string[] = [];
  const text = (): string => chunks.join('');
  return {
    stream: { write: (msg: string) => void chunks.push(msg) },
    text,
    lines: () => text().split('\n').filter(Boolean).map((line) => asRecord(JSON.parse(line))),
  };
}
