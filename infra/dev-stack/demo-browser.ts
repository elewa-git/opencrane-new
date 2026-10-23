import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { Page } from 'playwright';
import { answer, stop } from './real-model-journey.ts';
import { demoBudget, demoCeiling } from './demo-prepare.ts';
import { timedSmoke } from './demo-smoke.ts';
import { choosePerson } from './demo-rehearsal-checks.ts';
import { findBudgetNoticeForPrompt } from './browser-budgets.ts';
import { waitForPrivateSessionToApply } from './browser-phase4.ts';

type Options = Parameters<typeof demoBudget>[0];

export async function demoRefusal(page: Page, prompt: string) {
  const notice = await findBudgetNoticeForPrompt(page, prompt);
  await notice.getByText(/limit reached/iu).waitFor();
}

export async function warmDemo(owner: Page, member: Page, origin: string) {
  owner.setDefaultTimeout(120_000);
  member.setDefaultTimeout(120_000);
  await owner.goto(`${origin}/workspace?conversation=demo-supplier-v1`);
  await answer(owner, 'Say ready in one plain sentence. Do not use tools.', [/ready/iu]);
  await member.goto(`${origin}/workspace/shared`);
  await member.getByRole('button', { name: /^Choose Acacia supplier assistant/u }).click();
  const selection = member.getByRole('dialog');
  await selection.getByRole('button', { name: 'Start session', exact: true }).click();
  await waitForPrivateSessionToApply(member);
  await answer(member, 'Say ready in one plain sentence. Do not use tools.', [/ready/iu]);
  return member.url();
}

export async function demoBrowser(owner: Page, member: Page, options: Options,
  sharedUrl: string, output: string, attempt: number) {
  const { origin } = options;
  const supplierUrl = `${origin}/workspace?conversation=demo-supplier-v1`;
  async function streaming() {
    await owner.goto(supplierUrl);
    await answer(owner, 'What is 19 multiplied by 23? Explain in three plain sentences. ' +
      'Do not use tools.', [/\b437\b/u]);
  }
  async function pdf() {
    await owner.goto(supplierUrl);
    await answer(owner, 'Read the attached supplier quote. Give its total in euros and delivery ' +
      'date in one plain sentence. Do not use tools.',
    [/1[,. ]?234[,.]56/u, /17/u, /November|11/u, /2026/u]);
    await owner.getByRole('button', { name: 'Open supplier.pdf', exact: true }).click();
    await owner.getByText('Preview ready', { exact: true }).waitFor();
    const preview = owner.getByRole('dialog', { name: 'supplier.pdf', exact: true });
    assert.equal(await preview.locator('iframe').count(), 1);
    function nativeViewer(frame: ReturnType<Page['frames']>[number]) {
      return frame.url().startsWith('chrome-extension://');
    }
    const renderedBy = Date.now() + 10_000;
    while (true) {
      const frames = owner.frames();
      const viewer = frames.find(nativeViewer);
      const numberOptions = { name: 'Page number', exact: true, includeHidden: true };
      const number = viewer?.getByRole('textbox', numberOptions);
      if (number && await number.count() && await number.inputValue() === '1') break;
      assert(Date.now() < renderedBy, 'PDF preview did not render');
      await delay(100);
    }
    const link = preview.getByRole('link', { name: 'Download original file', exact: false });
    const href = await link.getAttribute('href');
    assert(href);
    const response = await owner.request.get(new URL(href, origin).href);
    assert.equal(response.status(), 200);
    const expected = await readFile(new URL('./fixtures/supplier.pdf', import.meta.url));
    assert((await response.body()).equals(expected), 'Downloaded PDF matches the checked file');
    await owner.screenshot({ path: `${output}/pdf-${attempt}.png` });
    await preview.getByRole('button', { name: 'Close preview', exact: true }).click();
  }
  async function stopped() {
    await owner.goto(supplierUrl);
    await stop(owner);
    await owner.screenshot({ path: `${output}/stop-${attempt}.png` });
  }
  async function direct() {
    await member.goto(`${origin}/workspace/direct`);
    await member.locator('.transcript[aria-busy="false"]').waitFor();
    for (const name of ['New chat', 'Change']) {
      const button = member.getByRole('button', { name, exact: true });
      if (await button.count()) {
        await button.click();
        break;
      }
    }
    await choosePerson(member, origin, 'zitadel-owner');
    await member.getByRole('button', { name: 'Use selection', exact: true }).click();
    const first = `Demo delivery ${randomUUID()}`;
    await member.locator('#message').fill(first);
    await member.getByRole('button', { name: 'Send message', exact: true }).click();
    await member.getByText(first, { exact: true }).waitFor();
    await owner.goto(member.url());
    await owner.getByText(first, { exact: true }).waitFor();
    const live = `Live delivery ${randomUUID()}`;
    await member.locator('#message').fill(live);
    await member.getByRole('button', { name: 'Send message', exact: true }).click();
    await owner.getByText(live, { exact: true }).waitFor();
  }
  async function shared() {
    await member.goto(sharedUrl);
    await answer(member, 'What is the capital of France? One plain sentence. Do not use tools.',
      [/\bParis\b/u]);
  }
  async function limit() {
    const before = await demoBudget(options);
    const id = randomUUID();
    try {
      await demoCeiling(options, `demo-limit-${id}`, before.ceilingCents, before.todayCents);
      await member.goto(sharedUrl);
      const composer = member.getByRole('textbox', { name: 'Message your agent' });
      const prompt = `Limit demonstration ${id}. Say hello in one plain sentence.`;
      await composer.fill(prompt);
      await composer.press('Enter');
      await demoRefusal(member, prompt);
      await member.reload();
      await demoRefusal(member, prompt);
      const refused = await demoBudget(options);
      assert.equal(refused.todayCents, before.todayCents);
      assert.equal(refused.reservedCents, before.reservedCents);
    } finally {
      // Let the run restore its saved original limits after interrupted work has stopped.
      if (!options.signal?.aborted) {
        await demoCeiling(options, `demo-restore-${id}`,
          before.ceilingCents, before.dailyCeilingCents);
      }
    }
  }
  const actions = [streaming, pdf, stopped, direct, shared, limit];
  function step(run: () => Promise<void>) {
    async function bounded(remainingMs: number) {
      options.signal?.throwIfAborted();
      owner.setDefaultTimeout(remainingMs);
      member.setDefaultTimeout(remainingMs);
      try {
        await run();
      } finally {
        await owner.screenshot({ path: `${output}/${run.name}-owner-${attempt}.png` });
        await member.setViewportSize({ width: attempt, height: attempt === 390 ? 844 : 900 });
        await member.screenshot({ path: `${output}/${run.name}-member-${attempt}.png` });
        await member.setViewportSize({ width: 390, height: 844 });
      }
    }
    return { name: run.name, run: bounded };
  }
  const steps = actions.map(step);
  async function expire() {
    await owner.close();
    await member.close();
  }
  function deadline() {
    void expire().catch(ignoreClosed);
  }
  function ignoreClosed() {
    // Allow the deadline to close pages that have already closed after a failure.
  }
  const timer = setTimeout(deadline, 180_000);
  try {
    return await timedSmoke(steps);
  } finally {
    clearTimeout(timer);
  }
}
