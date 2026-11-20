import '../dev-stack/journey-entry.ts';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { directory, root } from '../dev-stack/config.ts';
import { stackId } from '../dev-stack/identity.ts';
import { finishBrowserReplies, navigateWithReplies } from './provider-navigation.ts';
import { providerFailure } from './provider-failure.ts';
import { createProviderConnection, providerSetup, saveProviderKey } from './provider-settings.ts';
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

async function privateScript(script, input) {
  const args = [...connection.args, '-n', owner.namespace, 'exec', '-i', 'deployment/server',
    '-c', 'server', '--', 'node', '--input-type=module', '-e', script];
  const child = execFile('kubectl', args, { env: connection.environment, timeout: 30_000 });
  const finished = once(child, 'exit');
  child.stdin.end(JSON.stringify(input));
  let result = '';
  for await (const chunk of child.stdout) result += chunk.toString();
  const [exit] = await finished;
  assert.equal(exit, 0, 'Private inspection must finish without disclosing a key');
  return JSON.parse(result);
}

async function wrongKeyStatus() {
  const script = `
let input = '';
for await (const chunk of process.stdin) input += chunk.toString();
const key = JSON.parse(input);
const headers = { authorization: 'Bearer ' + key };
const response = await fetch('http://model-qualification:43003/v1/models', { headers });
const body = await response.text();
if (body.includes(key)) throw new Error('Credential disclosed by upstream');
console.log(JSON.stringify({ status: response.status() }));`;
  const result = await privateScript(script, wrongCredential);
  assert.equal(result.status, 401, 'The same wrong credential receives HTTP 401 upstream');
  outcomes.push({ check: 'wrong credential receives HTTP 401 from the separate stand-in',
    result: 'PASS', status: result.status });
}

async function login(role) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const user = setup.users[role];
  assert(user, 'The claimed slot must have this separate test identity');
  await navigateWithReplies(page, origin, responses);
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
  const inspection = inspect();
  // Keep errors for the next navigation or final check so the receipt records the failure.
  void Promise.allSettled([inspection]);
  responses.push(inspection);
}

async function capture(page, name, width) {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
  const body = await page.locator('body').innerText();
  for (const secret of secrets) assert(!body.includes(secret), 'Visible text disclosed a key');
  const fields = page.locator('input[type=password], input[type=email]');
  const addresses = page.getByText(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu);
  await page.screenshot({ path: `${output}/${name}-${width}.png`, fullPage: true,
    mask: [fields, addresses] });
}

async function screenshots(page, name) {
  for (const width of [1280, 390]) await capture(page, name, width);
  await page.setViewportSize({ width: 1280, height: 900 });
}

async function invite(ownerPage, role, membershipRole) {
  const memberId = randomUUID();
  const userName = setup.users[role].login.split('@')[0];
  const email = `${userName}@example.test`;
  const data = { commandId: randomUUID(), memberId, email, role: membershipRole,
    personalAssistant: 'provision', expectedSequence: 0 };
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

async function waitForDefault(page, providerId) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response = await page.request.get(`${origin}/api/org/providers/${providerId}/bindings`);
    assert.equal(response.status(), 200);
    const result = await response.json();
    function isDefault(row) { return row.kind === 'silo_default'; }
    if (result.rows.some(isDefault)) return;
    await delay(100);
  }
  throw new Error('The selected model default did not finish applying');
}

async function waitForModels(page, providerId) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response = await page.request.get(`${origin}/api/org/providers/${providerId}`);
    assert.equal(response.status(), 200);
    const result = await response.json();
    if (result.rows[0]?.enabledModels.includes('gpt-6.1-sol')) {
      const check = page.getByRole('button', { name: 'Check status', exact: true });
      if (await check.isVisible()) await check.click();
      return;
    }
    await delay(100);
  }
  throw new Error('The selected models did not finish applying');
}

async function connect(admin) {
  await navigateWithReplies(admin, `${origin}/workspace`, responses);
  await admin.getByRole('link', { name: 'Settings', exact: true }).click();
  await admin.getByRole('link', { name: /Models/ }).click();
  await admin.getByRole('heading', { name: 'Models & providers', exact: true }).waitFor();
  await screenshots(admin, 'admin-settings');
  await createProviderConnection(admin, 'Package free provider');
  const setup = providerSetup(admin);
  for (const width of [1280, 390]) {
    await admin.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const key = setup.getByLabel('API key Required', { exact: true });
    assert.equal(await key.count(), 1, 'Setup offers exactly one new-key field');
    assert.equal(await key.isVisible(), true, 'A person can enter a new key');
    await capture(admin, 'new-key-entry', width);
  }
  await admin.setViewportSize({ width: 1280, height: 900 });
  await saveProviderKey(admin, wrongCredential);
  await admin.getByRole('button', { name: 'Check provider reachability', exact: true }).waitFor();
  const inventory = await admin.request.get(`${origin}/api/org/providers`);
  const providerId = (await inventory.json()).rows[0].providerId;
  await admin.getByRole('button', { name: 'Check provider reachability', exact: true }).click();
  await waitForFact(admin, providerId, 'reachable', 'fail');
  const facts = setup.getByRole('region', { name: 'Provider verification facts', exact: true });
  await facts.getByText('The test failed. Nothing else changed.', { exact: true }).waitFor();
  await screenshots(admin, 'wrong-key-refused');
  await wrongKeyStatus();
  outcomes.push({ check: 'wrong key refused without disclosure', result: 'PASS' });
  await setup.locator('footer').getByRole('button', { name: 'Back', exact: true }).click();
  await saveProviderKey(admin, credential);
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
  await waitForModels(admin, providerId);
  await admin.getByRole('heading', { name: /Step 5 of 6/ }).waitFor();
  await admin.getByRole('button', { name: 'Next', exact: true }).click();
  await admin.getByRole('button', { name: 'Go to Models', exact: true }).click();
  const chat = admin.getByRole('region', { name: 'Member chat setup' });
  await chat.getByLabel('Chat model').selectOption('gpt-6.1-sol');
  await waitForDefault(admin, providerId);
  await chat.getByRole('button', { name: 'Select chat default', exact: true }).click();
  await chat.getByRole('button', { name: 'Pause new calls', exact: true }).click();
  await chat.getByRole('button', { name: 'Switch on member chats', exact: true }).click();
  await chat.getByText('Member chats switched on', { exact: true }).waitFor();
  await screenshots(admin, 'provider-switched-on');
  outcomes.push({ check: 'admin Settings connects, tests, selects and switches on', result: 'PASS' });
}

const modeScript = `
import { lstat, readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const directory = '/var/lib/opencrane/provider-secrets/keys';
const folder = await lstat(directory);
const keys = [];
for (const name of await readdir(directory)) {
  const file = directory + '/' + name;
  const details = await lstat(file);
  const bytes = await readFile(file);
  const hash = createHash('sha256');
  hash.update(bytes);
  keys.push({ mode: details.mode & 0o7777, uid: details.uid, digest: hash.digest('hex') });
}
function byDigest(first, second) {
  return first.digest.localeCompare(second.digest);
}
keys.sort(byDigest);
const state = { directoryMode: folder.mode & 0o7777, uid: folder.uid, keys };
console.log(JSON.stringify(state));`;


async function privateModes() {
  const output = await kube(['exec', 'deployment/server', '-c', 'server', '--', 'node',
    '--input-type=module', '-e', modeScript]);
  const state = JSON.parse(output);
  assert.equal(state.directoryMode, 0o700);
  assert.equal(state.uid, 1000);
  assert.equal(state.keys.length, 1, 'Only the current synthetic credential remains in custody');
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
  const logs = await kube(['logs', pod.items[0].metadata.name, '--all-containers=true',
    '--prefix=true', '--tail=-1']);
  for (const secret of secrets) assert(!logs.includes(secret), 'Setup logs disclosed a key');
  const logOptions = { mode: 0o600 };
  await writeFile(`${directory}/provider-before-recreation.log`, logs, logOptions);
  outcomes.push({ check: 'setup logs checked before Pod recreation', result: 'PASS' });
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
    await navigateWithReplies(member, `${origin}/workspace`, responses);
    const composer = member.getByRole('textbox', { name: 'Message your agent' });
    await composer.waitFor({ timeout: 120_000 });
    await member.keyboard.press('Control+n');
    await member.getByText('Draft', { exact: true }).waitFor();
    await composer.fill('Say hello briefly.');
    await composer.press('Enter');
    const reply = member.getByRole('article', { name: 'Agent reply', exact: true });
    await reply.getByText('Done', { exact: true }).waitFor({ timeout: 120_000 });
    assert.equal(await reply.locator('.prose').innerText(), 'Hello from your computer.');
    await capture(member, 'member-chat', width);
    outcomes.push({ check: `member chat at ${width}px`, result: 'PASS' });
  }
}

async function checkDisclosure() {
  const values = await readFile(`${directory}/package-values.json`, 'utf8');
  const manifests = await kube(['get', 'deployment,statefulset,cronjob,job,configmap', '-o', 'json']);
  const logs = await kube(['logs', '-l', 'app=server', '--all-containers=true',
    '--prefix=true', '--tail=-1']);
  for (const content of [values, manifests, logs]) {
    for (const secret of secrets) assert(!content.includes(secret), 'A public artifact disclosed a key');
  }
  const script = `
import { connectEventStore, readEvents } from '@opencrane/event-store';
let input = '';
for await (const chunk of process.stdin) input += chunk.toString();
const secrets = JSON.parse(input);
const events = await connectEventStore();
let count = 0;
try {
  const until = await events.store.head();
  if (until) {
    for await (const row of readEvents(events.store, 1, until)) {
      const text = JSON.stringify(row.event);
      for (const secret of secrets) {
        if (text.includes(secret)) throw new Error('Credential in event');
      }
      count++;
    }
  }
  console.log(JSON.stringify({ checkedEvents: count }));
} finally {
  await events.close();
}`;
  const inspected = await privateScript(script, secrets);
  assert(inspected.checkedEvents > 0);
  outcomes.push({ check: 'keys absent from values, manifests, environment values, logs and events',
    result: 'PASS', checkedEvents: inspected.checkedEvents });
}

try {
  await mkdir(output, { recursive: true });
  // Save the wrong key privately so the collector can remove it from failure logs.
  const privateFileOptions = { mode: 0o600 };
  await writeFile(`${directory}/model-qualification-wrong-key`, wrongCredential, privateFileOptions);
  browser = await chromium.launch({ headless: true, channel: 'chromium' });
  stage = 'owner sign-in';
  const ownerPage = await login('owner');
  stage = 'admin invitation and sign-in';
  const admin = await invite(ownerPage, 'without-assistant', 'admin');
  stage = 'member invitation and sign-in';
  const member = await invite(ownerPage, 'member', 'member');
  stage = 'Settings setup';
  await connect(admin);
  stage = 'provider Pod recreation';
  await recreateProviderPod();
  stage = 'member chat';
  await memberChats(member);
  stage = 'credential disclosure checks';
  await checkDisclosure();
  await finishBrowserReplies(browser, responses);
  browser = undefined;
  const git = await execute('git', ['rev-parse', 'HEAD'], { cwd: root });
  await writeFile(`${output}/result.json`, JSON.stringify({ status: 'PASS', source: git.stdout.trim(),
    outcomes, paidCalls: 0, paidCents: 0 }, null, 2) + '\n');
  console.log('PASS packaged provider Settings, refusal, private restart and member chats at 1280/390');
} catch (error) {
  outcomes.push(providerFailure({ check: stage, detail: 'The current journey step must complete.' }, error));
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
