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
const publicDirectoryOptions = { recursive: true };
await mkdir(output, publicDirectoryOptions);
const privateDirectoryOptions = { recursive: true, mode: 0o700 };
await mkdir(privateOutput, privateDirectoryOptions);
const config = loadAuthConfig(await authEnv());
const browserOptions = { headless: false, channel: 'chromium' };
const browser = await chromium.launch(browserOptions);
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
    const signInOptions = { name: 'Continue with single sign-on', exact: true };
    const signIn = page.getByRole('button', signInOptions);
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
  // Allow one frame to paint the new layout and another to finish before recording it.
  await page.evaluate(nextAnimationFrame);
  await page.evaluate(nextAnimationFrame);
  const path = `${output}/${name}-${width}.png`;
  const mask = [page.locator('.current-user')];
  const options = { path, fullPage: true, mask };
  await page.screenshot(options);
}

function agentReplies(page: Page): Locator {
  const options = { name: 'Agent reply', exact: true };
  return page.getByRole('article', options);
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
  const continueButtonOptions = { name: 'Continue', exact: true };
  const continueButton = page.getByRole('button', continueButtonOptions);
  await continueButton.click();
  const work = page.locator('#survey-work');
  await work.fill('I prepare clear presentations.');
  await continueButton.click();
  const warmOptions = { name: 'Warm', exact: true };
  const warm = page.getByRole('radio', warmOptions);
  await warm.click();
  const briefOptions = { name: 'Brief', exact: true };
  const brief = page.getByRole('radio', briefOptions);
  await brief.click();
  await continueButton.click();
  const draftDocumentsOptions = { name: 'Draft documents', exact: true };
  const draftDocuments = page.getByRole('button', draftDocumentsOptions);
  await draftDocuments.click();
  const reviewOptions = { name: 'Review persona', exact: true };
  const review = page.getByRole('button', reviewOptions);
  await review.click();
  const savedPersonaOptions = { name: 'Review saved persona', exact: true };
  const savedPersona = page.getByRole('link', savedPersonaOptions);
  await savedPersona.click();
  const editOptions = { name: 'Edit', exact: true };
  const edit = page.getByRole('button', editOptions);
  await edit.click();
  const persona = 'Your name is Aster. Be clear, honest and useful. '
    + 'Use your name in introductions and in the files you make.';
  const personaFieldOptions = { name: 'Persona', exact: true };
  const personaField = page.getByRole('textbox', personaFieldOptions);
  await personaField.fill(persona);
  const saveOptions = { name: 'Save as new revision', exact: true };
  const save = page.getByRole('button', saveOptions);
  await save.click();
  const approveOptions = { name: 'Approve this version', exact: true };
  const approve = page.getByRole('button', approveOptions);
  await approve.click();
  const approvedOptions = { exact: true };
  const approved = page.getByText('Approved revision r2', approvedOptions);
  await approved.waitFor();
  await screenshot(page, 'approved-persona', page.viewportSize()!.width);
}

async function preparePersona(page: Page): Promise<void> {
  await page.goto(`${origin}/welcome/persona`);
  const approvedOptions = { exact: true };
  const approved = page.getByText('Approved revision r2', approvedOptions);
  const absentOptions = { exact: true };
  const absent = page.getByText('No persona yet. Finish the survey first.', absentOptions);
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
  const url = frame.url();
  return url.startsWith('chrome-extension:');
}

function pdfPagesLoaded(): boolean {
  const viewer = document.querySelector('pdf-viewer');
  if (!viewer) {
    return false;
  }
  const check: unknown = Reflect.get(viewer, 'getLoadSucceededForTesting');
  if (typeof check !== 'function') {
    return false;
  }
  const loaded: unknown = Reflect.apply(check, viewer, []);
  return loaded === true;
}

async function waitForPdfPages(page: Page): Promise<void> {
  // Check Chromium's PDF viewer because a ready iframe can still show blank pages.
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
  const readyOptions = { exact: true };
  const ready = preview.getByText('Preview ready', readyOptions);
  await ready.waitFor();
  if (name.endsWith('.pdf')) {
    const pdfFrame = preview.locator('iframe[title="Document preview"]');
    await pdfFrame.waitFor();
    await waitForPdfPages(page);
  } else {
    const notesOptions = { exact: true };
    const notes = preview.getByText('Aster: clear and useful work.', notesOptions);
    await notes.waitFor();
  }
  await screenshot(page, name.endsWith('.pdf') ? 'deck-preview' : 'notes-preview', width);
  const downloaded = page.waitForEvent('download');
  const downloadLinkOptions = { name: 'Download original file', exact: false };
  const downloadLink = preview.getByRole('link', downloadLinkOptions);
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
  const closeOptions = { name: 'Close preview', exact: true };
  const close = page.getByRole('button', closeOptions);
  await close.click();
}

async function checkShareAction(page: Page, width: number): Promise<void> {
  const prompt = 'Save notes for the slide deck without sharing them yet.';
  await sendUploadedMessage(page, prompt, 'Aster_notes.txt');
  const replies = agentReplies(page);
  const unshared = replies.last();
  const noteOptions = { exact: true };
  const note = unshared.getByText('Aster_notes.txt — not shared by the agent.', noteOptions);
  await note.waitFor();
  const shareOptions = { name: 'Share Aster_notes.txt', exact: true };
  const share = unshared.getByRole('button', shareOptions);
  const box = await share.boundingBox();
  assert(box && box.height >= 44 && box.width >= 44);
  await screenshot(page, 'not-shared', width);
  const composerOptions = { name: 'Message your agent' };
  const composer = page.getByRole('textbox', composerOptions);
  await composer.fill('An unfinished question');
  assert(await share.isDisabled());
  await composer.fill('');
  const priorReplies = await replies.count();
  await share.focus();
  await share.press('Enter');
  const shared = replies.nth(priorReplies);
  const doneOptions = { exact: true };
  const done = shared.getByText('Done', doneOptions);
  const completionOptions = { timeout: 120_000 };
  await done.waitFor(completionOptions);
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
  const shareOptions = { name: 'Share antivirus-test.txt', exact: true };
  const share = unshared.getByRole('button', shareOptions);
  await share.click();
  const reply = replies.nth(priorReplies);
  const doneOptions = { exact: true };
  const done = reply.getByText('Done', doneOptions);
  const completionOptions = { timeout: 120_000 };
  await done.waitFor(completionOptions);
  const failedAction = reply.locator('oc-tool-activity-line button:has([data-state="failed"])');
  await failedAction.click();
  const refusalOptions = { exact: false };
  const refusal = reply.getByText('File refused: malware detected.', refusalOptions);
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
  const composerOptions = { name: 'Message your agent' };
  const composer = page.getByRole('textbox', composerOptions);
  await composer.waitFor();
  const sessionsLoadedOptions = { exact: true };
  const sessionsLoaded = page.getByText('Sessions loaded', sessionsLoadedOptions);
  const sessionOptions = { state: 'attached' as const };
  await sessionsLoaded.waitFor(sessionOptions);
  await page.keyboard.press('Control+n');
  const draftOptions = { exact: true };
  const draft = page.getByText('Draft', draftOptions);
  await draft.waitFor();
  await sendUploadedMessage(page, 'make a short slide deck introducing yourself', 'I am Aster.');
  const replies = agentReplies(page);
  const reply = replies.last();
  const replyText = await reply.innerText();
  assert(!replyText.includes('Codex'));
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
