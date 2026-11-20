import '../dev-stack/journey-entry.ts';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { directory, root } from '../dev-stack/config.ts';
import { stackId } from '../dev-stack/identity.ts';
import { enterLoginName } from '../dev-stack/browser-signin.ts';
import { packageConnectionArgs, verifyPackageOwner } from '../dev-stack/packaged.ts';

assert(['1', '2'].includes(stackId), 'A provider journey needs a claimed secondary stack');
const owner = await verifyPackageOwner();
const connection = await packageConnectionArgs(owner);
const execute = promisify(execFile);
const origin = `http://127.0.0.1:${25000 + Number(stackId) * 100 + 6}`;
const output = `${root}/docs/process/work-pilot-1110-s1/live`;
const setup = JSON.parse(await readFile(`${directory}/zitadel.json`, 'utf8'));
const credential = (await readFile(`${directory}/model-qualification-key`, 'utf8')).trim();
const wrongCredential = randomUUID();
const secrets = [credential, wrongCredential];
const responses = [];
const outcomes = [];
let browser;
let stage = 'browser launch';

async function kube(args) {
  const result = await execute('kubectl', [...connection.args, '-n', owner.namespace, ...args],
    { env: connection.environment, timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
  return result.stdout;
}

async function login(role) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const user = setup.users[role];
  assert(user, 'The claimed slot must have this separate test identity');
  await page.goto(origin);
  await page.getByRole('button', { name: 'Continue with single sign-on', exact: true }).click();
  await page.locator('input[name=loginName]').waitFor();
  await page.waitForLoadState('networkidle');
  await enterLoginName(page, user.login);
  const password = await readFile(user.passwordFile, 'utf8');
  secrets.push(password.trim());
  await page.locator('input[type=password]').fill(password);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  function returned(url) { return url.origin === origin && !url.pathname.startsWith('/auth/'); }
  await page.waitForURL(returned);
  page.on('response', inspectReply);
  return page;
}

function inspectReply(response) {
  if (!response.url().startsWith(`${origin}/api/`)) return;
  async function inspect() {
    const body = await response.text();
    for (const secret of secrets) assert(!body.includes(secret), 'An API reply disclosed a key');
  }
  responses.push(inspect());
}

async function screenshots(page, name) {
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const body = await page.locator('body').innerText();
    for (const secret of secrets) assert(!body.includes(secret), 'Visible text disclosed a key');
    const fields = page.locator('input[type=password], input[type=email]');
    const addresses = page.getByText(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu);
    await page.screenshot({ path: `${output}/${name}-${width}.png`, fullPage: true,
      mask: [fields, addresses] });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

async function invite(ownerPage, role, memberId, membershipRole, assistant) {
  const userName = setup.users[role].login.split('@')[0];
  const email = `${userName}@example.test`;
  const data = { commandId: randomUUID(), memberId, email, role: membershipRole,
    personalAssistant: assistant, expectedSequence: 0 };
  const response = await ownerPage.request.post(`${origin}/api/invitations`,
    { headers: { origin }, data });
  assert.equal(response.status(), 200, 'The owner can invite a separate journey identity');
  const invitation = await response.json();
  assert(invitation.invitationId, 'The invitation must be recorded');
  const page = await login(role);
  const joined = await page.request.post(`${origin}/members/join`, { headers: { origin },
    data: { memberId, invitationId: invitation.invitationId, commandId: randomUUID(),
      displayName: membershipRole === 'admin' ? 'Package admin' : 'Package member' } });
  assert.equal(joined.status(), 200, 'The separately signed-in person can accept');
  assert.equal((await joined.json()).status, 'joined');
  return page;
}

async function waitForFact(page, providerId, fact, outcome) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response = await page.request.get(`${origin}/api/org/providers/${providerId}`);
    assert.equal(response.status(), 200);
    const result = await response.json();
    if (result.rows[0]?.[fact]?.outcome === outcome) {
      const check = page.getByRole('button', { name: 'Check status', exact: true });
      if (await check.isVisible()) await check.click();
      return;
    }
    await delay(100);
  }
  throw new Error('Provider verification did not reach the expected terminal outcome');
}

async function connect(admin) {
  await admin.goto(`${origin}/workspace`);
  await admin.getByRole('link', { name: 'Settings', exact: true }).click();
  await admin.getByRole('link', { name: /Models/ }).click();
  await admin.getByRole('heading', { name: 'Models & providers', exact: true }).waitFor();
  await screenshots(admin, 'admin-settings');
  await admin.getByRole('button', { name: 'Connect a provider', exact: true }).first().click();
  await admin.getByLabel('Connection name').fill('Package free provider');
  await admin.getByRole('button', { name: 'Next', exact: true }).click();
  await admin.getByLabel('API key', { exact: false }).fill(wrongCredential);
  await admin.getByRole('button', { name: 'Save key', exact: true }).click();
  await admin.getByRole('button', { name: 'Check provider reachability', exact: true }).waitFor();
  const inventory = await admin.request.get(`${origin}/api/org/providers`);
  const providerId = (await inventory.json()).rows[0].providerId;
  await admin.getByRole('button', { name: 'Check provider reachability', exact: true }).click();
  await waitForFact(admin, providerId, 'reachable', 'fail');
  await admin.getByText('The test failed. Nothing else changed.', { exact: true }).first().waitFor();
  await screenshots(admin, 'wrong-key-refused');
  outcomes.push({ check: 'wrong key refused without disclosure', result: 'PASS' });
  await admin.getByRole('button', { name: 'Back', exact: true }).click();
  await admin.getByLabel('API key', { exact: false }).fill(credential);
  await admin.getByRole('button', { name: 'Save key', exact: true }).click();
  await admin.getByRole('button', { name: 'Check provider reachability', exact: true }).click();
  await waitForFact(admin, providerId, 'reachable', 'pass');
  await admin.getByRole('button', { name: 'Read current price', exact: true }).click();
  await admin.getByRole('checkbox', { name: /I agree to one priced test request/ }).check();
  await screenshots(admin, 'quoted-test');
  await admin.getByRole('button', { name: 'Run priced test', exact: true }).click();
  await waitForFact(admin, providerId, 'modelAnswer', 'pass');
  await screenshots(admin, 'model-test-passed');
  await admin.getByRole('button', { name: 'Next', exact: true }).click();
  await admin.getByRole('checkbox', { name: /gpt-6\.1-sol/ }).check();
  await admin.getByRole('checkbox', { name: /gpt-6-luna/ }).check();
  await admin.getByRole('button', { name: 'Next', exact: true }).click();
  await admin.getByRole('heading', { name: /Step 5 of 6/ }).waitFor();
  await admin.getByRole('button', { name: 'Next', exact: true }).click();
  await admin.getByRole('button', { name: 'Go to Models', exact: true }).click();
  const chat = admin.getByRole('region', { name: 'Member chat setup' });
  await chat.getByLabel('Chat model').selectOption('gpt-6.1-sol');
  await chat.getByRole('button', { name: 'Select chat default', exact: true }).click();
  await chat.getByRole('button', { name: 'Pause new calls', exact: true }).click();
  await chat.getByRole('button', { name: 'Switch on member chats', exact: true }).click();
  await chat.getByText('Member chats switched on', { exact: true }).waitFor();
  await screenshots(admin, 'provider-switched-on');
  outcomes.push({ check: 'admin Settings connects, tests, selects and switches on', result: 'PASS' });
}

const modeScript = `
import {lstat, readdir, readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const directory='/var/lib/opencrane/provider-secrets/keys';
const folder=await lstat(directory);
const keys=[];
for(const name of await readdir(directory)) {
 const file=directory+'/'+name;
 const details=await lstat(file);
 keys.push({mode:details.mode & 0o7777,uid:details.uid,
  digest:createHash('sha256').update(await readFile(file)).digest('hex')});
}
keys.sort((first,second)=>first.digest.localeCompare(second.digest));
console.log(JSON.stringify({directoryMode:folder.mode & 0o7777,uid:folder.uid,keys}));`;

async function privateModes() {
  const output = await kube(['exec', 'deployment/server', '-c', 'server', '--', 'node',
    '--input-type=module', '-e', modeScript]);
  const state = JSON.parse(output);
  assert.equal(state.directoryMode, 0o700);
  assert.equal(state.uid, 1000);
  assert(state.keys.length >= 2, 'Both synthetic key revisions must be in custody');
  for (const key of state.keys) {
    assert.equal(key.mode, 0o600);
    assert.equal(key.uid, 1000);
  }
  return state;
}

async function recreateProviderPod() {
  const before = await privateModes();
  const pod = JSON.parse(await kube(['get', 'pods', '-l', 'app=server', '-o', 'json']));
  const oldUid = pod.items[0].metadata.uid;
  await kube(['delete', 'pod', pod.items[0].metadata.name, '--wait=true']);
  await kube(['rollout', 'status', 'deployment/server', '--timeout=180s']);
  const replaced = JSON.parse(await kube(['get', 'pods', '-l', 'app=server', '-o', 'json']));
  assert.notEqual(replaced.items[0].metadata.uid, oldUid);
  const after = await privateModes();
  assert.deepEqual(after, before, 'Private modes and synthetic credential bytes survive recreation');
  outcomes.push({ check: 'Pod recreation preserves synthetic credential bytes and modes', result: 'PASS',
    directoryModeBefore: '0700', directoryModeAfter: '0700', fileModeBefore: '0600',
    fileModeAfter: '0600', keys: after.keys.length });
}

async function memberChats(member) {
  for (const width of [1280, 390]) {
    await member.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await member.goto(`${origin}/workspace`);
    const composer = member.getByRole('textbox', { name: 'Message your agent' });
    await composer.waitFor({ timeout: 120_000 });
    await member.keyboard.press('Control+n');
    await member.getByText('Draft', { exact: true }).waitFor();
    await composer.fill('Say hello briefly.');
    await composer.press('Enter');
    const reply = member.getByRole('article', { name: 'Agent reply', exact: true });
    await reply.getByText('Done', { exact: true }).waitFor({ timeout: 120_000 });
    assert.equal(await reply.locator('.prose').innerText(), 'Hello from your computer.');
    const privateFields = member.locator('input[type=password], input[type=email]');
    await member.screenshot({ path: `${output}/member-chat-${width}.png`, fullPage: true,
      mask: [privateFields] });
    outcomes.push({ check: `member chat at ${width}px`, result: 'PASS' });
  }
}

try {
  await mkdir(output, { recursive: true });
  browser = await chromium.launch({ headless: true, channel: 'chromium' });
  stage = 'owner sign-in';
  const ownerPage = await login('owner');
  stage = 'admin invitation and sign-in';
  const admin = await invite(ownerPage, 'without-assistant', 'package-admin', 'admin', 'none');
  stage = 'member invitation and sign-in';
  const member = await invite(ownerPage, 'member', 'package-member', 'member', 'provision');
  stage = 'Settings setup';
  await connect(admin);
  stage = 'provider Pod recreation';
  await recreateProviderPod();
  stage = 'member chat';
  await memberChats(member);
  await Promise.all(responses);
  const git = await execute('git', ['rev-parse', 'HEAD'], { cwd: root });
  await writeFile(`${output}/result.json`, JSON.stringify({ status: 'PASS', source: git.stdout.trim(),
    outcomes, paidCalls: 0, paidCents: 0 }, null, 2) + '\n');
  console.log('PASS packaged provider Settings, refusal, private restart and member chats at 1280/390');
} catch (error) {
  outcomes.push({ check: stage, result: 'FAIL' });
  await writeFile(`${output}/result.json`, JSON.stringify({ status: 'FAIL', outcomes,
    errorType: error?.name ?? 'Error', paidCalls: 0, paidCents: 0 }, null, 2) + '\n');
  let diagnostic = String(error?.stack ?? error);
  for (const secret of secrets) diagnostic = diagnostic.replaceAll(secret, '[redacted]');
  diagnostic = diagnostic.replaceAll(root, '[worktree]').replaceAll(directory, '[slot]');
  diagnostic = diagnostic.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, '[address]');
  await writeFile(`${directory}/provider-journey-failure.txt`, diagnostic, { mode: 0o600 });
  // Keep page content, credentials and local paths out of diagnostics.
  console.error(`FAIL packaged provider journey during ${stage}`);
  process.exitCode = 1;
} finally {
  await browser?.close();
}
