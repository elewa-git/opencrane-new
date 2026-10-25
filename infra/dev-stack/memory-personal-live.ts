import './journey-entry.ts';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { chromium, type Request, type Response } from 'playwright';
import { connectEventStore } from '@opencrane/event-store';
import { requireStageBStack } from './stage-b-guard.ts';
import { requireStandInJourney } from './journey-guard.ts';
import { directory, readEnv, root } from './config.ts';
import { exercisePersonalMemory } from './memory-personal-steps.ts';
import { enterLoginName, testUsers } from './browser-signin.ts';
import { captureMemory, memoryOutput, openMemory,
  recordMemory } from './memory-personal-browser.ts';

const id = process.env['DEV_STACK_ID'];
await requireStageBStack(id, process.env['MEMORY_CLAIMED_ID'] ?? '', homedir(), root);
const settings = await readEnv('settings');
requireStandInJourney(settings);
const origin = settings['ORIGIN']!;
const execute = promisify(execFile);
await mkdir(memoryOutput, { recursive: true });
await writeFile(`${memoryOutput}/observations.jsonl`, '', { flag: 'wx', mode: 0o600 });
const browser = await chromium.launch({ headless: true, channel: 'chromium' });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
page.setDefaultTimeout(30_000);
function failedSessionRead(request: Request) {
  if (new URL(request.url()).pathname !== '/auth/me') return;
  const error = request.failure()?.errorText;
  const code = error && /^net::[A-Z_]+$/u.test(error) ? error : 'unavailable';
  void recordMemory('session-read-failed', { code });
}
function sessionReply(response: Response) {
  if (new URL(response.url()).pathname !== '/auth/me') return;
  void recordMemory('session-read', { status: response.status() });
}
page.on('requestfailed', failedSessionRead);
page.on('response', sessionReply);
let stage = 'empty install';
try {
  const events = await connectEventStore(await readEnv('projection'));
  try {
    for await (const _row of events.store.readStream('member-*')) {
      assert.fail('The installation already has a member');
    }
  } finally {
    await events.close();
  }
  const installed = await execute('npm', ['run', 'bootstrap-token', '-w', 'apps/server'], {
    cwd: root, env: { ...process.env, SILO_ID: settings['SILO_ID'],
      BOOTSTRAP_TOKEN_FILE: `${directory}/bootstrap-token.json` },
  });
  const output = installed.stdout.trim();
  const lines = output.split('\n');
  const token = lines.at(-1)!;
  assert(/^[A-Za-z0-9_-]{43}$/u.test(token), 'Installation token is required');
  stage = 'real SSO';
  const user = (await testUsers()).owner;
  await page.goto(`${origin}/claim`);
  await page.getByRole('link', { name: 'Sign in to claim', exact: true }).click();
  await page.locator('input[name=loginName]').waitFor();
  await page.waitForLoadState('networkidle');
  await enterLoginName(page, user.login);
  await page.locator('input[type=password]').fill(await readFile(user.passwordFile, 'utf8'));
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.waitForURL(`${origin}/claim`);
  stage = 'owner claim';
  await page.getByLabel('Display name').fill('Memory test owner');
  await page.getByLabel('Contact email').fill((await readFile(`${directory}/memory-owner-email`, 'utf8')).trim());
  await page.getByLabel('Bootstrap token').fill(token);
  await page.getByRole('button', { name: 'Claim this silo', exact: true }).click();
  await page.getByRole('heading', { name: 'You are the silo owner' }).waitFor();
  await recordMemory('bootstrap', { result: 'PASS', empty: true, realSso: true });
  stage = 'first personal memory read';
  await openMemory(page, origin);
  await captureMemory(page, 'empty-memory');
  await recordMemory('baseline', { result: 'PASS', qualification: 'PARTIAL' });
  stage = 'personal memory operations';
  await exercisePersonalMemory(page, origin);
} catch {
  await recordMemory('failure', { result: 'FAIL', stage });
  await captureMemory(page, 'failure');
  throw new Error(`Personal memory qualification failed at ${stage}; replies remain in observations`);
} finally {
  await page.context().storageState({ path: `${directory}/memory-browser.json` });
  await browser.close();
}
