import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
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

async function createPersonalConversation(options: Options, assistantId: string) {
  const conversationId = 'demo-supplier-v1';
  const id = 'demo-supplier-create-v1';
  const data = { id, conversationId, assistantId };
  // The receipt needs an existing chat. Record the attempt before creating it,
  // so a lost reply or refused receipt can never cause another creation request.
  if (await reserveRequest(options.directory, id)) {
    try {
      await request(options, '/api/conversations', data);
    } catch {
      // Read the original receipt after an uncertain reply.
    }
  }
  await savedCommand(options, '/api/conversations',
    `/api/conversations/${conversationId}/changes/${id}`, id, data);
  return conversationId;
}

const savedCeilingsSchema = z.object({
  ceilingCents: z.int().nonnegative(), dailyCeilingCents: z.int().nonnegative(),
  commandId: z.string().uuid(),
});

export async function saveDemoCeilings(options: Options, output: string) {
  await mkdir(output, { recursive: true, mode: 0o700 });
  const path = `${output}/saved-ceilings.json`;
  try {
    return savedCeilingsSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const budget = await demoBudget(options);
  const saved = { ceilingCents: budget.ceilingCents,
    dailyCeilingCents: budget.dailyCeilingCents, commandId: randomUUID() };
  // Finish saving before any ceiling write, so a later process can restore both values.
  await writeFile(path, JSON.stringify(saved), { flag: 'wx', mode: 0o600, flush: true });
  return saved;
}

export async function restoreDemoCeilings(options: Options, output: string) {
  const path = `${output}/saved-ceilings.json`;
  let saved;
  try {
    saved = savedCeilingsSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  // Append even when the read table already shows these limits. Advance the stream
  // so an earlier interrupted write with an old expected sequence cannot raise them later.
  await demoCeiling(options, `demo-restore-${randomUUID()}`,
    saved.ceilingCents, saved.dailyCeilingCents);
  await rm(path);
}

export async function recoverDemoCeilings(options: Options) {
  const parent = `${options.directory}/demo-smoke`;
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const entries = await readdir(parent, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) await restoreDemoCeilings(options, `${parent}/${entry.name}`);
  }
}

export async function prepareDemo(options: Options, allowanceCents: number,
  output = `${options.directory}/demo-smoke/preparation`) {
  assert(Number.isInteger(allowanceCents) && allowanceCents > 0 && allowanceCents <= 2000,
    'Demo allowance must be 1 to 2000 integer cents');
  const saved = await saveDemoCeilings(options, output);
  try {
    await demoCeiling(options, `demo-ceiling-${saved.commandId}`, allowanceCents, allowanceCents);
    return await preparePersonalPdf(options);
  } catch (error) {
    const restoring = { ...options, signal: undefined };
    await restoreDemoCeilings(restoring, output);
    throw error;
  }
}

async function preparePersonalPdf(options: Options) {
  const context = await request(options, '/api/chat');
  const personal = await context.json() as { assistantId?: string };
  const assistantId = personal.assistantId;
  assert(context.ok && assistantId, 'Personal assistant required');
  assert(assistantId.startsWith('personal-'), 'Personal assistant required');
  const conversationId = await createPersonalConversation(options, assistantId);
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
        signal: AbortSignal.any([AbortSignal.timeout(120_000),
          ...(options.signal ? [options.signal] : [])]) };
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
