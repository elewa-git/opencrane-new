import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { Page } from 'playwright';
import type { EventStore } from '@opencrane/event-store';
import { uploadPdf } from '../../apps/server/test/support/upload-pdf.ts';
import { root } from './config.ts';

async function draft(page: Page, origin: string) {
  page.setDefaultTimeout(120_000);
  await page.goto(`${origin}/workspace`);
  await page.getByRole('textbox', { name: 'Message your agent' }).waitFor();
  await page.keyboard.press('Control+n');
  await page.getByText('Draft', { exact: true }).waitFor();
}

async function answer(page: Page, prompt: string, facts: RegExp[]) {
  const composer = page.getByRole('textbox', { name: 'Message your agent' });
  await composer.fill(prompt);
  await composer.press('Enter');
  await page.locator('.caret').waitFor();
  const reply = page.getByRole('article', { name: 'Agent reply', exact: true }).last();
  await reply.getByText('Done', { exact: true }).waitFor();
  const text = await reply.locator('.prose').innerText();
  for (const fact of facts) assert(fact.test(text), 'The real reply must contain the expected fact');
  await page.reload();
  await reply.getByText('Done', { exact: true }).waitFor();
  assert.equal(await reply.locator('.prose').innerText(), text, 'Reload keeps the answer');
}

async function stop(page: Page) {
  const composer = page.getByRole('textbox', { name: 'Message your agent' });
  await composer.fill('Write a long numbered list of 200 European cities and describe each one.');
  await composer.press('Enter');
  await page.locator('.caret').waitFor();
  const reply = page.getByRole('article', { name: 'Agent reply', exact: true }).last();
  await reply.locator('.prose').filter({ hasText: /[a-z]/iu }).waitFor();
  await page.locator('oc-chat-composer').getByRole('button', { name: 'Stop', exact: true }).click();
  await page.getByText('Stopped · partial reply kept', { exact: true }).waitFor();
  const partial = await reply.locator('.prose').innerText();
  assert(partial.length > 0, 'Stop keeps received text');
  await page.reload();
  await page.getByText('Stopped · partial reply kept', { exact: true }).waitFor();
  assert.equal(await reply.locator('.prose').innerText(), partial);
}

async function supplier(page: Page, origin: string) {
  await draft(page, origin);
  await page.getByRole('button', { name: 'Attach', exact: true }).click();
  const choosing = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Upload from computer', exact: true }).click();
  const chooser = await choosing;
  const buffer = uploadPdf('EUR 1234.56; due 17 November 2026');
  await chooser.setFiles({ name: 'supplier.pdf', mimeType: 'application/pdf', buffer });
  await page.locator('.upload-status').filter({ hasText: 'Ready' }).waitFor();
  await answer(page, 'Read the attached supplier quote. What is the total in euros and the ' +
    'delivery date? Reply in one plain sentence. Do not use tools.',
  [/1[,. ]?234[,.]56/u, /17/u, /November|11/u, /2026/u]);
}

export async function realModelJourney(owner: Page, member: Page, origin: string,
  store: EventStore, silo: string) {
  const outcomes: Array<{ check: string; result: string }> = [];
  let check = 'owner streamed reply and reload';
  try {
    await draft(owner, origin);
    await answer(owner, 'What is 19 multiplied by 23? Explain the calculation in three sentences. Do not use tools.',
      [/\b437\b/u]);
    outcomes.push({ check, result: 'PASS' });
    check = 'Stop and reload';
    await stop(owner);
    outcomes.push({ check, result: 'PASS' });
    check = 'later member through the default';
    await draft(member, origin);
    await answer(member, 'What is the capital of France? One plain sentence. Do not use tools.',
      [/\bParis\b/iu]);
    outcomes.push({ check, result: 'PASS' });
    check = 'scanned supplier PDF total and delivery date';
    await supplier(member, origin);
    outcomes.push({ check, result: 'PASS' });
  } catch {
    outcomes.push({ check, result: 'FAIL' });
    throw new Error(`Real journey failed: ${check}`);
  } finally {
    const spending = new Map<string, { turnId: string | null; reservedCents: number; chargedCents: number | null }>();
    for await (const row of store.readStream(`budget-${silo}`)) {
      const data = row.event.data as Record<string, unknown>;
      const id = String(data['reservationId']);
      if (row.event.type === 'budget.reserved') {
        const call = data['modelCall'] as { turnId?: string } | undefined;
        spending.set(id, { turnId: call?.turnId ?? null,
          reservedCents: Number(data['amountCents']), chargedCents: null });
      }
      if (row.event.type === 'budget.settled') {
        const reservation = spending.get(id);
        if (reservation && data['outcome'] !== 'unknown') {
          reservation.chargedCents = Number(data['settledCents']);
        }
      }
    }
    const commit = await promisify(execFile)('git', ['rev-parse', 'HEAD'], { cwd: root });
    const receipt = { sha: commit.stdout.trim(), outcomes, reservations: [...spending.entries()] };
    const folder = `${root}/docs/process/demo-real-model`;
    await mkdir(folder, { recursive: true });
    await writeFile(`${folder}/live.json`, JSON.stringify(receipt, null, 2) + '\n');
  }
  console.log('PASS real replies: streaming, reload, Stop, later member and supplier PDF');
}
