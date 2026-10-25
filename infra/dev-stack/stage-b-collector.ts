import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, writeFileSync,
} from 'node:fs';
import assert from 'node:assert/strict';
import type { EventStore, StoredEvent } from '@opencrane/event-store';

export function createStageBCollector(output: string) {
  mkdirSync(output, { recursive: true });
  const snapshot = `${output}/live-probe.json`;
  const journal = `${output}/live-probe.jsonl`;
  if (existsSync(snapshot) || existsSync(journal)) {
    throw new Error('Use a new output directory to keep earlier evidence');
  }
  const descriptor = openSync(journal, 'wx', 0o600);
  closeSync(descriptor);
  const results: Record<string, unknown> = {};
  return { results, record };

  function record<Value>(name: string, value: Value): Value {
    const entry = { name, value };
    const json = JSON.stringify(entry);
    const redacted = json.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu,
      '[EMAIL REDACTED]');
    // Save each observation before replacing the summary or awaiting another service.
    writeSynced(journal, `${redacted}\n`, 'a');
    results[name] = value;
    const summary = JSON.stringify(results, null, 2);
    const safeSummary = summary.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu,
      '[EMAIL REDACTED]');
    const temporary = `${snapshot}.next`;
    writeSynced(temporary, safeSummary, 'w');
    renameSync(temporary, snapshot);
    return value;
  }
}

function writeSynced(path: string, content: string, flag: 'a' | 'w') {
  const descriptor = openSync(path, flag, 0o600);
  try {
    writeFileSync(descriptor, content);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

type ApprovalResponse = {
  path: string;
  method: string;
  status: number;
  command: unknown;
  body?: string;
  response?: unknown;
  error?: string;
};

export async function collectStageBApprovalResponse(
  collector: ReturnType<typeof createStageBCollector>, response: import('playwright').Response,
) {
  const request = response.request();
  const path = new URL(response.url()).pathname;
  if (!path.includes('/approvals') || request.method() !== 'POST') return;
  const row: ApprovalResponse = {
    path, method: request.method(), status: response.status(), command: request.postDataJSON(),
  };
  const previous = collector.results['approvalResponses'] as ApprovalResponse[] | undefined;
  const responses = previous ?? [];
  collector.record('approvalResponses', [...responses, row]);
  try {
    row.body = await response.text();
  } catch (error) {
    row.error = String(error);
    saveResponses();
    return;
  }
  saveResponses();
  try {
    row.response = JSON.parse(row.body) as unknown;
  } catch (error) {
    row.error = String(error);
  }
  saveResponses();

  function saveResponses() {
    const current = collector.results['approvalResponses'] as ApprovalResponse[];
    collector.record('approvalResponses', current);
  }
}

export async function collectStageBRecords(collector: ReturnType<typeof createStageBCollector>,
  name: string, store: Pick<EventStore, 'readStream'>, subject: string, silo: string,
  accept: (row: StoredEvent) => boolean) {
  const previous = collector.results[name] as StoredEvent[] | undefined;
  const rows = [...(previous ?? [])];
  function position(row: StoredEvent) {
    return row.sequence;
  }
  const positions = rows.map(position);
  const seen = new Set(positions);
  const deadline = performance.now() + 30000;
  for await (const row of store.readStream(subject, 1, deadline)) {
    assert.equal(row.event.silo, silo);
    if (!accept(row) || seen.has(row.sequence)) continue;
    seen.add(row.sequence);
    rows.push(row);
    collector.record(name, rows);
  }
  collector.record(name, rows);
  return rows;
}
