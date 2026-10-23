import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Page } from 'playwright';
import { answer, stop } from './real-model-journey.ts';
import { demoBudget, demoCeiling } from './demo-prepare.ts';
import { demoRefusal } from './demo-browser.ts';
import { waitForPrivateSessionToApply } from './browser-phase4.ts';
import {
  checkChangeHistory, checkProviderAnswer, rehearsalStep,
} from './demo-rehearsal-checks.ts';

type Options = Parameters<typeof demoBudget>[0];

export async function demoRehearsal(owner: Page, member: Page, options: Options,
  output: string, allowance: number, sanitise: (value: string) => string) {
  const { origin } = options;
  const supplier = new URL('./fixtures/supplier.pdf', import.meta.url);
  const attempt = randomUUID();
  let identity = '';
  let stepPictures: string[] = [];
  let failed = false;
  let width = 1280;
  let conversation = '';
  let privateUrl = '';

  async function picture(page: Page, name: string) {
    const addresses = page.getByText(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu);
    const credentials = page.locator('input[type="password"], #invitation-link');
    const providerValues = page.getByText(/sk-[A-Za-z0-9_-]{12,}/u);
    const settings = {
      path: `${output}/${name}-${width}.png`, mask: [addresses, credentials, providerValues],
    };
    await page.screenshot(settings);
    stepPictures.push(settings.path);
  }
  async function paidAllowance() {
    const budget = await demoBudget(options);
    assert(budget.todayCents + budget.reservedCents + 100 <= allowance,
      'The next turn needs more than the remaining task allowance');
  }
  async function draft() {
    await owner.goto(`${origin}/workspace`);
    await owner.getByRole('textbox', { name: 'Message your agent' }).waitFor();
    await owner.keyboard.press('Control+n');
    await owner.getByText('Draft', { exact: true }).waitFor();
  }
  async function streamedReply() {
    await paidAllowance();
    await draft();
    await answer(owner, `Rehearsal ${identity}. What is 19 multiplied by 23? ` +
      'Explain in three plain sentences. Do not use tools.', [/\b437\b/u]);
  }
  async function scannedPdf() {
    await paidAllowance();
    await draft();
    await owner.getByRole('button', { name: 'Attach', exact: true }).click();
    const choosing = owner.waitForEvent('filechooser');
    await owner.getByRole('button', { name: 'Upload from computer', exact: true }).click();
    const chooser = await choosing;
    await chooser.setFiles(supplier.pathname);
    const ready = owner.locator('.upload-status').filter({ hasText: 'Ready' });
    await ready.waitFor();
    await picture(owner, '02-upload-ready');
    await answer(owner, `Rehearsal ${identity}. Read the attached supplier quote. ` +
      'Give its total in euros and delivery date in one plain sentence. Do not use tools.',
      [/1[,. ]?234[,.]56/u, /17/u, /November|11/u, /2026/u]);
    conversation = new URL(owner.url()).searchParams.get('conversation')!;
    assert(conversation);
    await owner.getByRole('button', { name: 'Open supplier.pdf', exact: true }).click();
    await owner.getByText('Preview ready', { exact: true }).waitFor();
    const preview = owner.getByRole('dialog', { name: 'supplier.pdf', exact: true });
    assert.equal(await preview.locator('iframe').count(), 1);
    const renderedBy = Date.now() + 10000;
    while (true) {
      function nativeViewer(frame: ReturnType<Page['frames']>[number]) {
        return frame.url().startsWith('chrome-extension://');
      }
      const frames = owner.frames();
      const viewer = frames.find(nativeViewer);
      const pageNumber = viewer?.getByRole('textbox', {
        name: 'Page number', exact: true, includeHidden: true,
      });
      if (pageNumber && await pageNumber.count() && await pageNumber.inputValue() === '1') {
        break;
      }
      assert(Date.now() < renderedBy, 'PDF preview did not render');
      await delay(100);
    }
    const link = preview.getByRole('link', { name: 'Download original file', exact: false });
    const href = await link.getAttribute('href');
    assert(href);
    const download = await owner.request.get(new URL(href, origin).href);
    assert.equal(download.status(), 200);
    const expected = await readFile(supplier);
    assert((await download.body()).equals(expected), 'Downloaded PDF matches the scanned fixture');
    await picture(owner, '02-preview-download');
    await preview.getByRole('button', { name: 'Close preview', exact: true }).click();
  }
  async function actionHistory() {
    await owner.goto(`${origin}/history/${conversation}`);
    await owner.getByText('Decision: allow', { exact: true }).first().waitFor();
    await owner.getByText('Observed outcome: Success', { exact: true }).first().waitFor();
  }
  async function stoppedReply() {
    await paidAllowance();
    await owner.goto(`${origin}/workspace?conversation=${conversation}`);
    const prompt = `Rehearsal ${identity}. Write a long numbered list of 200 European cities ` +
      'and describe each one.';
    await stop(owner, prompt);
    assert.equal(await owner.getByText('Reply failed', { exact: true }).count(), 0);
  }
  async function choosePerson(page: Page, memberId: string) {
    const response = await page.request.get(`${origin}/api/chat/colleagues?limit=50`);
    assert.equal(response.status(), 200);
    const people = await response.json() as {
      rows: Array<{ memberId: string; displayName?: string }>;
    };
    function chosen(person: { memberId: string }) {
      return person.memberId === memberId;
    }
    const person = people.rows.find(chosen);
    assert(person, 'The selected colleague exists');
    await page.locator('#colleague-search').fill(person.displayName ?? person.memberId);
    const selectedName = person.displayName ?? person.memberId;
    const matchingPerson = page.locator('.colleague-option').filter({ hasText: selectedName });
    await matchingPerson.click();
  }
  async function changeRecipients(page: Page) {
    await page.goto(`${origin}/workspace/direct`);
    await page.locator('.transcript[aria-busy="false"]').waitFor();
    for (const label of ['New chat', 'Change']) {
      const button = page.getByRole('button', { name: label, exact: true });
      if (await button.count()) {
        await button.click();
        break;
      }
    }
  }
  async function humanMessage(page: Page, text: string) {
    await page.locator('#message').fill(text);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.getByText(text, { exact: true }).waitFor();
  }
  async function liveMessage() {
    await member.setViewportSize({ width: 390, height: 844 });
    await changeRecipients(member);
    await choosePerson(member, 'zitadel-owner');
    await member.getByRole('button', { name: 'Use selection', exact: true }).click();
    const first = `Rehearsal direct ${identity}`;
    await humanMessage(member, first);
    await owner.goto(member.url());
    await owner.getByText(first, { exact: true }).waitFor();
    const live = `Live arrival ${identity}`;
    await humanMessage(member, live);
    await owner.getByText(live, { exact: true }).waitFor();
    await picture(member, '05-member-phone');
  }
  async function sharedReply() {
    await paidAllowance();
    await member.setViewportSize({ width, height: 900 });
    await member.goto(`${origin}/workspace/shared`);
    await member.getByRole('button', { name: /^Choose Acacia supplier assistant/u }).click();
    await member.getByRole('dialog').getByRole('button', {
      name: 'Start session', exact: true,
    }).click();
    await waitForPrivateSessionToApply(member);
    await answer(member, `Rehearsal ${identity}. What is the capital of France? ` +
      'One plain sentence. Do not use tools.',
      [/\bParis\b/iu]);
    privateUrl = member.url();
    await picture(member, '06-private-shared-reply');
  }
  async function groupAndInvite() {
    await changeRecipients(owner);
    await choosePerson(owner, 'zitadel-member');
    await choosePerson(owner, 'jente-rosseel');
    await owner.getByText('Group conversation', { exact: false }).first().waitFor();
    const message = `Rehearsal group ${identity}`;
    await humanMessage(owner, message);
    await member.goto(owner.url());
    await member.getByText(message, { exact: true }).waitFor();
    await picture(owner, '07-group-chat');
    await owner.goto(`${origin}/org/people/groups/demo-acacia`);
    await owner.getByRole('heading', { name: 'Acacia Trading', exact: true }).waitFor();
    await picture(owner, '07-group');
    await owner.goto(`${origin}/org/people`);
    await owner.getByRole('button', { name: 'Invite people', exact: true }).click();
    const email = `rehearsal-${identity}@example.invalid`;
    await owner.getByLabel('Person email', { exact: true }).fill(email);
    await owner.getByRole('button', { name: 'Create', exact: true }).click();
    await owner.getByText('Link created. No email was sent.', { exact: true }).waitFor();
    assert((await owner.locator('#invitation-link').inputValue()).length > 0);
    await picture(owner, '07-unopened-invite');
    await owner.getByRole('button', { name: 'Done', exact: true }).click();
  }
  async function providerAnswer() {
    await owner.goto(`${origin}/org/models`);
    await checkProviderAnswer(owner);
  }
  async function companyLimit() {
    const before = await demoBudget(options);
    let checkFailure: { error: unknown } | undefined;
    try {
      await owner.goto(`${origin}/org/spending`);
      await owner.getByLabel('Budget scope', { exact: true }).selectOption('global');
      const monthly = owner.getByLabel('Monthly ceiling (euro cents)', { exact: true });
      await monthly.fill(String(before.ceilingCents));
      const daily = owner.getByLabel('Daily safety cap (euro cents)', { exact: true });
      await daily.fill(String(before.todayCents));
      await owner.getByRole('button', { name: 'Save budget', exact: true }).click();
      await owner.getByText('Budget saved', { exact: true }).waitFor();
      await member.goto(privateUrl);
      const prompt = `Rehearsal limit ${identity}. Say hello in one plain sentence.`;
      const composer = member.getByRole('textbox', { name: 'Message your agent' });
      await composer.fill(prompt);
      await composer.press('Enter');
      await demoRefusal(member, prompt);
      await member.reload();
      await demoRefusal(member, prompt);
      await picture(member, '09-member-refusal');
      const refused = await demoBudget(options);
      assert.equal(refused.todayCents, before.todayCents);
      assert.equal(refused.reservedCents, before.reservedCents);
    } catch (error) {
      checkFailure = { error };
      throw error;
    } finally {
      try {
        await demoCeiling(options, `rehearsal-restore-${identity}`,
          before.ceilingCents, before.dailyCeilingCents);
        const restored = await demoBudget(options);
        assert.equal(restored.ceilingCents, before.ceilingCents);
        assert.equal(restored.dailyCeilingCents, before.dailyCeilingCents);
        await owner.reload();
      } catch (restorationError) {
        if (checkFailure) {
          // Keep the checker failure first and report the failed restoration alongside it.
          const errors = [checkFailure.error, restorationError];
          throw new AggregateError(errors, 'Company-limit check and restoration failed');
        }
        throw restorationError;
      }
    }
  }
  async function changeHistory() {
    await owner.goto(`${origin}/org/history`);
    async function captureHistory(name: string) {
      await picture(owner, name);
    }
    await checkChangeHistory(owner, captureHistory);
  }
  const steps = [streamedReply, scannedPdf, actionHistory, stoppedReply, liveMessage,
    sharedReply, groupAndInvite, providerAnswer, companyLimit, changeHistory];
  const results = [];
  for (width of [1280, 390]) {
    identity = `${attempt}-${width}`;
    await owner.setViewportSize({ width, height: 900 });
    await member.setViewportSize({ width, height: 900 });
    owner.setDefaultTimeout(120_000);
    member.setDefaultTimeout(120_000);
    for (let index = 0; index < steps.length; index++) {
      stepPictures = [];
      const run = steps[index]!;
      const prefix = String(index + 1).padStart(2, '0');
      async function capture(result: string) {
        if (result === 'FAIL') {
          await picture(owner, `${prefix}-failure-owner`);
          await picture(member, `${prefix}-failure-member`);
        } else {
          await picture(owner, `${prefix}-${run.name}`);
        }
        return stepPictures;
      }
      let outcome;
      if (failed) {
        outcome = { result: 'NOT RUN', elapsedMs: 0 };
      } else {
        outcome = await rehearsalStep(run, capture, sanitise);
        failed = outcome.result === 'FAIL';
      }
      results.push({ step: index + 1, name: run.name, width, ...outcome });
      const contents = JSON.stringify(results, null, 2);
      await writeFile(`${output}/results.json`, contents, { mode: 0o600 });
      console.log(`${outcome.result} ${width}px ${index + 1} ${run.name}`);
    }
  }
  return !failed;
}
