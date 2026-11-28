/// <reference lib="dom" />
import './journey-entry.ts';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Locator, Page } from 'playwright';
import { loadAuthConfig } from '@opencrane/auth';
import { authEnv, readEnv, root } from './config.ts';
import { requireStageBStack } from './stage-b-guard.ts';
import { requireStandInJourney } from './journey-guard.ts';
import { browserSessions } from './browser-signin.ts';
import { sendUploadedMessage } from './browser-upload-message.ts';

assert.equal(process.env['DEV_STACK_ID'], '1');
await requireStageBStack('1', '1', homedir(), root);
const settings = await readEnv('settings');
requireStandInJourney(settings);
const origin = settings['ORIGIN'];
assert(origin);
const output = 'docs/process/work-share-1220-s1';
const privateOutput = join(homedir(), '.fleet', 'receipts', 'share-1220-s1');
await mkdir(output, { recursive: true });
await mkdir(privateOutput, { recursive: true, mode: 0o700 });
const config = loadAuthConfig(await authEnv());
const sessions = await browserSessions(config, origin);
const results: object[] = [];

async function screenshot(page: Page, name: string, width: number): Promise<void> {
  const path = `${output}/${name}-${width}.png`;
  const mask = [page.locator('.current-user')];
  await page.screenshot({ path, fullPage: true, mask });
}

function agentReplies(page: Page): Locator {
  return page.getByRole('article', { name: 'Agent reply', exact: true });
}

function sharedFileCard(page: Page, name: string): Locator {
  const cards = page.locator('oc-conversation-file-card');
  const namedFile = { hasText: name };
  return cards.filter(namedFile);
}

async function approvePersona(page: Page): Promise<void> {
  await page.goto(`${origin}/welcome/survey`);
  const name = page.locator('#survey-name');
  await name.fill('Sam');
  const continueButton = page.getByRole('button', { name: 'Continue', exact: true });
  await continueButton.click();
  const work = page.locator('#survey-work');
  await work.fill('I prepare clear presentations.');
  await continueButton.click();
  const warm = page.getByRole('radio', { name: 'Warm', exact: true });
  await warm.click();
  const brief = page.getByRole('radio', { name: 'Brief', exact: true });
  await brief.click();
  await continueButton.click();
  const draftDocuments = page.getByRole('button', { name: 'Draft documents', exact: true });
  await draftDocuments.click();
  const review = page.getByRole('button', { name: 'Review persona', exact: true });
  await review.click();
  const edit = page.getByRole('button', { name: 'Edit', exact: true });
  await edit.click();
  const persona = 'Your name is Aster. Be clear, honest and useful. '
    + 'Use your name in introductions and in the files you make.';
  const personaField = page.getByRole('textbox', { name: 'Persona', exact: true });
  await personaField.fill(persona);
  const save = page.getByRole('button', { name: 'Save as new revision', exact: true });
  await save.click();
  const approve = page.getByRole('button', { name: 'Approve this version', exact: true });
  await approve.click();
  const approved = page.getByText('Approved revision r2', { exact: true });
  await approved.waitFor();
  await screenshot(page, 'approved-persona', page.viewportSize()!.width);
  const welcome = page.getByRole('link', { name: 'Open welcome chat', exact: true });
  await welcome.click();
  const startWelcome = page.getByRole('button', { name: 'Continue with your assistant', exact: true });
  await startWelcome.click();
  const answer = page.getByRole('textbox', { name: 'Your answer', exact: true });
  await answer.fill('I would like help making clear slide decks.');
  const sendAnswer = page.getByRole('button', { name: 'Send answer', exact: true });
  await sendAnswer.click();
  const completedWelcome = page.locator('.crease');
  const completion = completedWelcome.filter({ hasText: 'Welcome complete' });
  await completion.waitFor();
}

async function openAndDownload(page: Page, name: string, width: number): Promise<void> {
  const card = sharedFileCard(page, name);
  const openOptions = { name: `Open ${name}`, exact: true };
  const open = card.getByRole('button', openOptions);
  await open.click();
  const preview = page.locator('oc-file-preview');
  const ready = preview.getByText('Preview ready', { exact: true });
  await ready.waitFor();
  if (name.endsWith('.pdf')) {
    const pdfFrame = preview.locator('iframe[title="Document preview"]');
    await pdfFrame.waitFor();
  } else {
    const notes = preview.getByText('Aster: clear and useful work.', { exact: true });
    await notes.waitFor();
  }
  await screenshot(page, name.endsWith('.pdf') ? 'deck-preview' : 'notes-preview', width);
  const downloaded = page.waitForEvent('download');
  const downloadLink = preview.getByRole('link', { name: 'Download original file', exact: false });
  await downloadLink.click();
  const download = await downloaded;
  assert.equal(download.suggestedFilename(), name);
  const path = join(privateOutput, `${width}-${name}`);
  await download.saveAs(path);
  const bytes = await readFile(path);
  assert(bytes.includes(Buffer.from('Aster')));
  if (name.endsWith('.pdf')) {
    const pdf = bytes.toString();
    assert(pdf.startsWith('%PDF-1.4'));
    const pages = pdf.match(/\/Type \/Page /gu);
    assert.equal(pages?.length, 3);
  }
  const result = { width, file: name, bytes: bytes.length, preview: 'PASS', download: 'PASS' };
  results.push(result);
  const close = page.getByRole('button', { name: 'Close preview', exact: true });
  await close.click();
}

async function checkShareAction(page: Page, width: number): Promise<void> {
  const prompt = 'Save notes for the slide deck without sharing them yet.';
  await sendUploadedMessage(page, prompt, 'Aster_notes.txt');
  const replies = agentReplies(page);
  const unshared = replies.last();
  const note = unshared.getByText('Aster_notes.txt — not shared by the agent.', { exact: true });
  await note.waitFor();
  const share = unshared.getByRole('button', { name: 'Share Aster_notes.txt', exact: true });
  const box = await share.boundingBox();
  assert(box && box.height >= 44 && box.width >= 44);
  await screenshot(page, 'not-shared', width);
  const composer = page.getByRole('textbox', { name: 'Message your agent' });
  await composer.fill('An unfinished question');
  assert(await share.isDisabled());
  await composer.fill('');
  const priorReplies = await replies.count();
  await share.focus();
  await share.press('Enter');
  const shared = replies.nth(priorReplies);
  const done = shared.getByText('Done', { exact: true });
  await done.waitFor({ timeout: 120_000 });
  const card = sharedFileCard(page, 'Aster_notes.txt');
  await card.waitFor();
  await screenshot(page, 'shared-notes', width);
  await openAndDownload(page, 'Aster_notes.txt', width);
}

async function checkScanRefusal(page: Page, width: number): Promise<void> {
  await sendUploadedMessage(page, 'Save an antivirus test file without sharing it yet.',
    'antivirus-test.txt');
  const replies = agentReplies(page);
  const priorReplies = await replies.count();
  const unshared = replies.last();
  const share = unshared.getByRole('button', { name: 'Share antivirus-test.txt', exact: true });
  await share.click();
  const reply = replies.nth(priorReplies);
  const done = reply.getByText('Done', { exact: true });
  await done.waitFor({ timeout: 120_000 });
  const refusal = reply.getByText('File refused: malware detected.', { exact: false });
  await refusal.waitFor();
  const card = sharedFileCard(page, 'antivirus-test.txt');
  assert.equal(await card.count(), 0);
  await screenshot(page, 'scan-refusal', width);
  const result = { width, sharing: 'PASS', scannerRefusal: 'PASS' };
  results.push(result);
}

function fitsViewport(element: HTMLElement | SVGElement): boolean {
  return element.scrollWidth <= element.clientWidth;
}

async function checkWidth(page: Page): Promise<void> {
  const width = page.viewportSize()!.width;
  await page.goto(`${origin}/workspace`);
  const composer = page.getByRole('textbox', { name: 'Message your agent' });
  await composer.waitFor();
  await page.keyboard.press('Control+n');
  const draft = page.getByText('Draft', { exact: true });
  await draft.waitFor();
  await sendUploadedMessage(page, 'make a short slide deck introducing yourself', 'I am Aster.');
  const replies = agentReplies(page);
  const reply = replies.last();
  assert(!(await reply.innerText()).includes('Codex'));
  const deck = sharedFileCard(page, 'Meet_Aster.pdf');
  await deck.waitFor();
  await screenshot(page, 'shared-deck', width);
  await openAndDownload(page, 'Meet_Aster.pdf', width);
  await page.reload();
  await deck.waitFor();
  await checkShareAction(page, width);
  await checkScanRefusal(page, width);
  const document = page.locator('html');
  assert(await document.evaluate(fitsViewport));
  const transcript = page.locator('.transcript');
  assert(await transcript.evaluate(fitsViewport));
  console.log(`PASS file sharing at ${width}px: persona, deck, preview, download, Share and scanning`);
}

function isDesktopPage(page: Page): boolean {
  return page.viewportSize()?.width === 1280;
}

try {
  const desktop = sessions.memberPages.find(isDesktopPage);
  assert(desktop);
  await approvePersona(desktop);
  for (const page of sessions.memberPages) {
    await checkWidth(page);
  }
  const summary = { verdict: 'PASS', provider: 'free stand-in', spentCents: 0, results };
  await writeFile(`${output}/results.json`, JSON.stringify(summary, null, 2) + '\n');
} finally {
  await sessions.browser.close();
}
