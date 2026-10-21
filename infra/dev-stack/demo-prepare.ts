import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { budgetSummarySchema } from '@opencrane/protocol';
import { request, reserveRequest } from './demo-seed.ts';

type Options = Parameters<typeof request>[0];

export async function demoBudget(options: Options) {
  const response = await request(options, '/api/org/models');
  assert(response.ok, 'Demo spending unavailable');
  const data = await response.json() as { budget: unknown };
  return budgetSummarySchema.parse(data.budget);
}

export async function demoCeiling(options: Options, commandId: string,
  ceilingCents: number, dailyCeilingCents: number) {
  const path = `/api/org/models/changes/${commandId}`;
  const budget = await demoBudget(options);
  const data = { commandId, expectedSequence: budget.sequence, scope: 'global',
    ceilingCents, dailyCeilingCents };
  await savedCommand(options, '/api/org/models', path, commandId, data);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const current = await demoBudget(options);
    if (current.ceilingCents === ceilingCents && current.dailyCeilingCents === dailyCeilingCents) {
      return;
    }
    await delay(100);
  }
  throw new Error('Demo ceiling not current');
}

async function savedCommand(options: Options, path: string, receiptPath: string,
  commandId: string, data: Record<string, unknown>) {
  const previous = await request(options, receiptPath);
  assert(previous.ok || previous.status === 404, 'Demo receipt unavailable');
  const receipt = await previous.json() as { status?: string };
  if (receipt.status !== 'appended' && await reserveRequest(options.directory, commandId)) {
    try {
      await request(options, path, data);
    } catch {
      // Read the original receipt after a lost reply. Never repeat an unknown write.
    }
  }
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = await request(options, receiptPath);
    const saved = await result.json() as { status?: string;
      projection?: { content: string; iam: string } };
    assert(result.ok && saved.status === 'appended', 'Demo command outcome unknown');
    if (!saved.projection || (saved.projection.content === 'current' &&
        saved.projection.iam === 'current')) return;
    await delay(100);
  }
  throw new Error('Demo command still applying');
}

export async function prepareDemo(options: Options, allowanceCents: number) {
  assert(Number.isInteger(allowanceCents) && allowanceCents > 0 && allowanceCents <= 2000,
    'Demo allowance must be 1 to 2000 integer cents');
  await demoCeiling(options, `demo-ceiling-${allowanceCents}-v1`, allowanceCents, allowanceCents);
  const context = await request(options, '/api/chat');
  const personal = await context.json() as { assistantId?: string };
  assert(context.ok && personal.assistantId?.startsWith('personal-'), 'Personal assistant required');
  const conversationId = 'demo-supplier-v1';
  const id = 'demo-supplier-create-v1';
  const data = { id, conversationId, assistantId: personal.assistantId };
  await savedCommand(options, '/api/conversations',
    `/api/conversations/${conversationId}/changes/${id}`, id, data);
  const path = `/api/conversations/${conversationId}/files`;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const response = await request(options, path);
    assert(response.ok, 'Demo files unavailable');
    const list = await response.json() as { rows: Array<{ name: string; status: string }> };
    function supplier(file: typeof list.rows[number]) {
      return file.name === 'supplier.pdf';
    }
    const file = list.rows.find(supplier);
    if (file?.status === 'delivered') return conversationId;
    if (!file && await reserveRequest(options.directory, 'demo-supplier-upload-v1')) {
      const bytes = await readFile(new URL('./fixtures/supplier.pdf', import.meta.url));
      const headers = { origin: options.origin, cookie: options.cookie,
        'content-type': 'application/octet-stream', 'x-file-name': 'supplier.pdf',
        'idempotency-key': 'demo-supplier-upload-v1' };
      const init = { method: 'POST', headers, body: bytes, redirect: 'error' as const,
        signal: AbortSignal.timeout(120_000) };
      try {
        await fetch(`${options.origin}${path}`, init);
      } catch {
        // The file list proves delivery without uploading again after an uncertain reply.
      }
    }
    await delay(100);
  }
  throw new Error('Demo PDF delivery unknown');
}
