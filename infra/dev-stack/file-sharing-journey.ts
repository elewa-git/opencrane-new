/// <reference lib="dom" />
import './journey-entry.ts';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Frame, type Locator, type Page } from 'playwright';
import { loadAuthConfig } from '@opencrane/auth';
import { authEnv, readEnv, root } from './config.ts';
import { requireStageBStack } from './stage-b-guard.ts';
import { requireStandInJourney } from './journey-guard.ts';
import { completeProviderSignIn, testUsers } from './browser-signin.ts';
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
const browser = await chromium.launch({ headless: false, channel: 'chromium' });
const results: object[] = [];

async function signInMembers(browser: Browser, origin: string): Promise<Page[]> {
  const users = await testUsers();
  const member = users.member;
  const password = await readFile(member.passwordFile, 'utf8');
  const pages: Page[] = [];
  for (const width of [1280, 390]) {
    const options = { viewport: { width, height: width === 390 ? 844 : 900 } };
    const context = await browser.newContext(options);
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    await page.goto(origin);
    const signIn = page.getByRole('button', { name: 'Continue with single sign-on', exact: true });
    await signIn.click();
    await completeProviderSignIn(page, member.login, password, origin, config.issuerUrl);
    pages.push(page);
  }
  return pages;
}

function nextAnimationFrame(): Promise<number> {
  return new Promise<number>(requestAnimationFrame);
}

async function screenshot(page: Page, name: string, width: number): Promise<void> {
  await page.evaluate(nextAnimationFrame);
  await page.evaluate(nextAnimationFrame);
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
  const savedPersona = page.getByRole('link', { name: 'Review saved persona', exact: true });
  await savedPersona.click();
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

}

async function preparePersona(page: Page): Promise<void> {
  await page.goto(`${origin}/welcome/persona`);
  const approved = page.getByText('Approved revision r2', { exact: true });
  const absent = page.getByText('No persona yet. Finish the survey first.', { exact: true });
  const personaState = approved.or(absent);
  await personaState.waitFor();
  if (await approved.isVisible()) {
    const persona = page.locator('.persona-text');
    const text = await persona.innerText();
    assert(text.startsWith('Your name is Aster.'));
    await screenshot(page, 'approved-persona', page.viewportSize()!.width);
    return;
  }
  await approvePersona(page);
}

function isPdfViewer(frame: Frame): boolean {
  return frame.url().startsWith('chrome-extension:');
}

function pdfPagesLoaded(): boolean {
  const viewer = document.querySelector('pdf-viewer');
  if (!viewer) return false;
  const check: unknown = Reflect.get(viewer, 'getLoadSucceededForTesting');
  if (typeof check !== 'function') return false;
  const loaded: unknown = Reflect.apply(check, viewer, []);
  return loaded === true;
}

async function waitForPdfPages(page: Page): Promise<void> {
  const frames = page.frames();
  let viewer = frames.find(isPdfViewer);
  if (!viewer) {
    viewer = await page.waitForEvent('framenavigated', isPdfViewer);
  }
  await viewer.waitForFunction(pdfPagesLoaded);
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
    await waitForPdfPages(page);
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
  const failedAction = reply.locator('oc-tool-activity-line button:has([data-state="failed"])');
  await failedAction.click();
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
  const sessionsLoaded = page.getByText('Sessions loaded', { exact: true });
  await sessionsLoaded.waitFor({ state: 'attached' });
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
  const pages = await signInMembers(browser, origin);
  const desktop = pages.find(isDesktopPage);
  assert(desktop);
  await preparePersona(desktop);
  for (const page of pages) {
    await checkWidth(page);
  }
  const summary = { verdict: 'PASS', provider: 'free stand-in', spentCents: 0, results };
  await writeFile(`${output}/results.json`, JSON.stringify(summary, null, 2) + '\n');
} finally {
  await browser.close();
}
