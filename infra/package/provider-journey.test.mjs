import '../dev-stack/journey-entry.ts';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { postJourneyCommand, readJourneyApi } from '../dev-stack/browser-api.ts';
import { chargedBudgetJourney } from '../dev-stack/charged-budget-journey.ts';
import { directory, root } from '../dev-stack/config.ts';
import { stackId } from '../dev-stack/identity.ts';
import { finishBrowserReplies, navigateWithReplies, runShutdownStep, waitForBrowserReplies,
  watchBrowserReplies } from './provider-navigation.ts';
import { assertNoBrowserDisclosure, checkProviderArtifacts } from './provider-disclosure.ts';
import { providerFailure, writeShutdownFailure } from './provider-failure.ts';
import { providerEventDisclosureScript, qualificationRequestCountScript, withBudgetQualification,
  wrongKeyStatusScript }
  from './provider-probe.ts';
import { createProviderConnection, finishSelectingProviderModels, providerSetup, saveProviderKey,
  selectChatDefault, verifyProvider } from './provider-settings.ts';
import { completeProviderSignIn } from '../dev-stack/browser-signin.ts';
import { packageConnectionArgs, verifyPackageOwner } from '../dev-stack/packaged.ts';

assert(['1', '2'].includes(stackId), 'A provider journey needs a claimed secondary stack');
const owner = await verifyPackageOwner();
const connection = await packageConnectionArgs(owner);
const execute = promisify(execFile);
const origin = `http://127.0.0.1:${25000 + Number(stackId) * 100 + 6}`;
const budget = process.argv[2] === '--budget';
const output = budget ? `${directory}/package-budget-journey`
  : `${root}/docs/process/work-pilot-1110-s1/live`;
const setup = JSON.parse(await readFile(`${directory}/zitadel.json`, 'utf8'));
const credential = (await readFile(`${directory}/model-qualification-key`, 'utf8')).trim();
const wrongCredential = randomUUID();
const secrets = [credential, wrongCredential];
const inspectBrowserBody = assertNoBrowserDisclosure.bind(undefined, secrets);
const responses = [];
const outcomes = [];
let browser;
let stage = { check: 'browser launch', detail: 'Chromium must launch for the packaged journey.' };

function step(check, detail) {
  stage = { check, detail };
}

const recordShutdownFailure = writeShutdownFailure.bind(
  undefined, `${directory}/browser-shutdown.log`, secrets);

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
  const result = await privateScript(wrongKeyStatusScript, wrongCredential);
  assert.equal(result.status, 401, 'The same wrong credential receives HTTP 401 upstream');
  outcomes.push({ check: 'wrong credential receives HTTP 401 from the separate stand-in',
    result: 'PASS', status: result.status });
}

async function login(role) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await watchBrowserReplies(page, origin, responses, inspectBrowserBody);
  page.setDefaultTimeout(30_000);
  const user = setup.users[role];
  assert(user, 'The claimed slot must have this separate test identity');
  await navigateWithReplies(page, origin, responses);
  await page.getByRole('button', { name: 'Continue with single sign-on', exact: true }).click();
  const password = await readFile(user.passwordFile, 'utf8');
  secrets.push(password.trim());
  await completeProviderSignIn(page, user.login, password, origin, setup.issuer);
  return page;
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
  stage = { check: `invite ${membershipRole}`, expectedHttpStatus: 200,
    detail: 'The owner must be able to save the invitation.' };
  const response = await postJourneyCommand(ownerPage, origin, '/api/invitations', data);
  assert.equal(response.status(), 200, 'The owner can invite a separate journey identity');
  const invitation = await response.json();
  assert(invitation.invitationId, 'The invitation must be recorded');
  step(`${membershipRole} sign-in`, 'The invited person must finish single sign-on.');
  const page = await login(role);
  stage = { check: `${membershipRole} accepts invitation`, expectedHttpStatus: 200,
    detail: 'The separately signed-in person must be able to accept the invitation.' };
  const join = { memberId, invitationId: invitation.invitationId, commandId: randomUUID(),
    displayName: membershipRole === 'admin' ? 'Package admin' : 'Package member' };
  const joined = await postJourneyCommand(page, origin, '/members/join', join);
  assert.equal(joined.status(), 200, 'The separately signed-in person can accept');
  assert.equal((await joined.json()).status, 'joined');
  return { page, memberId };
}

async function waitForModels(page, providerId) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response = await readJourneyApi(page, `${origin}/api/org/providers/${providerId}`);
    assert.equal(response.status(), 200);
    const result = await response.json();
    if (result.rows[0]?.enabledModels.includes('gpt-6.1-sol')) {
      await finishSelectingProviderModels(page);
      return;
    }
    await delay(100);
  }
  throw new Error('The selected models did not finish applying');
}

async function connect(admin) {
  step('open Settings', 'The person setting up the provider must reach Models & providers.');
  await navigateWithReplies(admin, `${origin}/workspace`, responses);
  await admin.getByRole('link', { name: 'Settings', exact: true }).click();
  await admin.getByRole('link', { name: /Models/ }).click();
  await admin.getByRole('heading', { name: 'Models & providers', exact: true }).waitFor();
  await screenshots(admin, budget ? 'owner-settings' : 'admin-settings');
  step('create provider connection', 'The saved connection must advance to its Key step.');
  await createProviderConnection(admin, 'Package free provider');
  const setup = providerSetup(admin);
  for (const width of [1280, 390]) {
    step(`new-key field at ${width}px`, 'Setup must offer one visible new-key field.');
    await admin.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const key = setup.getByLabel('API key Required', { exact: true });
    assert.equal(await key.count(), 1, 'Setup offers exactly one new-key field');
    assert.equal(await key.isVisible(), true, 'A person can enter a new key');
    await capture(admin, 'new-key-entry', width);
  }
  await admin.setViewportSize({ width: 1280, height: 900 });
  step('save wrong synthetic key', 'Saving the key must advance to the Verify step.');
  await saveProviderKey(admin, wrongCredential);
  await admin.getByRole('button', { name: 'Check provider reachability', exact: true }).waitFor();
  const inventory = await readJourneyApi(admin, `${origin}/api/org/providers`);
  const providerId = (await inventory.json()).rows[0].providerId;
  const providerUrl = `${origin}/api/org/providers/${providerId}`;
  step('wrong-key reachability', 'Verification must report failed reachability for the wrong key.');
  await verifyProvider(admin, providerUrl, 'Check provider reachability', 'fail');
  const facts = setup.getByRole('region', { name: 'Provider verification facts', exact: true });
  await facts.getByText('The test failed. Nothing else changed.', { exact: true }).waitFor();
  await screenshots(admin, 'wrong-key-refused');
  step('wrong-key HTTP refusal', 'The private wrong-key probe must complete and return HTTP 401.');
  await wrongKeyStatus();
  outcomes.push({ check: 'wrong key refused without disclosure', result: 'PASS' });
  await setup.locator('footer').getByRole('button', { name: 'Back', exact: true }).click();
  step('save right synthetic key', 'Saving the replacement must advance to the Verify step.');
  await saveProviderKey(admin, credential);
  step('right-key reachability', 'Verification must report successful provider reachability.');
  await verifyProvider(admin, providerUrl, 'Check provider reachability', 'pass');
  step('quoted model test', 'The agreed quoted test must produce a successful model answer.');
  await admin.getByRole('button', { name: 'Read current price', exact: true }).click();
  await admin.getByRole('checkbox', { name: /I agree to one priced test request/ }).check();
  await screenshots(admin, 'quoted-test');
  await verifyProvider(admin, providerUrl, 'Run priced test', 'pass');
  await facts.getByText(/ answered$/u).waitFor();
  await screenshots(admin, 'model-test-passed');
  await admin.getByRole('button', { name: 'Next', exact: true }).click();
  step('model selection', 'The selected chat models must finish applying.');
  await admin.getByRole('checkbox', { name: /gpt-6\.1-sol/ }).check();
  await admin.getByRole('checkbox', { name: /gpt-6-luna/ }).check();
  await admin.getByRole('button', { name: 'Next', exact: true }).click();
  await waitForModels(admin, providerId);
  await admin.getByRole('button', { name: 'Next', exact: true }).click();
  await admin.getByRole('button', { name: 'Go to Models', exact: true }).click();
  step('select chat default', 'Selecting the chat default must save its model binding.');
  const chat = await selectChatDefault(admin, origin, providerId, 'gpt-6.1-sol');
  step('switch on member chats', 'Drained provider admission must allow member chats to switch on.');
  await chat.getByRole('button', { name: 'Pause new calls', exact: true }).click();
  await chat.getByRole('button', { name: 'Switch on member chats', exact: true }).click();
  await chat.getByText('Member chats switched on', { exact: true }).waitFor();
  await screenshots(admin, 'provider-switched-on');
  outcomes.push({ check: 'Settings connects, tests, selects and switches on', result: 'PASS' });
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
  step('private modes before recreation',
    'Custody must have one uid 1000 key with 0600 files and a 0700 folder.');
  const before = await privateModes();
  const pod = JSON.parse(await kube(['get', 'pods', '-l', 'app=server', '-o', 'json']));
  const oldUid = pod.items[0].metadata.uid;
  const logs = await kube(['logs', pod.items[0].metadata.name, '--all-containers=true',
    '--prefix=true', '--tail=-1']);
  for (const secret of secrets) assert(!logs.includes(secret), 'Setup logs disclosed a key');
  const logOptions = { mode: 0o600 };
  await writeFile(`${directory}/provider-before-recreation.log`, logs, logOptions);
  outcomes.push({ check: 'setup logs checked before Pod recreation', result: 'PASS' });
  step('recreate provider Pod', 'The replacement server Pod must become ready.');
  await kube(['delete', 'pod', pod.items[0].metadata.name, '--wait=true']);
  await kube(['rollout', 'status', 'deployment/server', '--timeout=180s']);
  const replaced = JSON.parse(await kube(['get', 'pods', '-l', 'app=server', '-o', 'json']));
  assert.notEqual(replaced.items[0].metadata.uid, oldUid);
  step('private modes after recreation', 'Recreation must preserve private modes and credential bytes.');
  const after = await privateModes();
  assert.deepEqual(after, before, 'Private modes and synthetic credential bytes survive recreation');
  outcomes.push({ check: 'Pod recreation preserves synthetic credential bytes and modes', result: 'PASS',
    directoryModeBefore: '0700', directoryModeAfter: '0700', fileModeBefore: '0600',
    fileModeAfter: '0600', keys: after.keys.length });
}

async function memberChats(member) {
  for (const width of [1280, 390]) {
    step(`member chat at ${width}px`, 'A member message must receive the expected free-provider reply.');
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

function readRequestCount() {
  return privateScript(qualificationRequestCountScript, null);
}

function inspectBeforeNavigation(page) {
  return waitForBrowserReplies(page, responses);
}

async function runMemberJourney(ownerPage, admin, member) {
  if (budget) {
    const pages = { owner: ownerPage, admin: admin.page, member: member.page };
    const journey = { ...pages, memberId: member.memberId, origin, readRequestCount, capture, step,
      beforeNavigate: inspectBeforeNavigation };
    const results = await chargedBudgetJourney(journey);
    outcomes.push(...results);
  } else {
    step('provider Pod recreation', 'Private custody must survive server Pod recreation.');
    await recreateProviderPod();
    step('member chat', 'Member chats must receive replies at both viewport widths.');
    await memberChats(member.page);
  }
}

async function checkDisclosure() {
  function readLocalValues() {
    return readFile(`${directory}/package-values.json`, 'utf8');
  }
  async function readInstalledValues() {
    const args = ['get', 'values', owner.release, '--all', '-o', 'json',
      '--kube-context', owner.context, '-n', owner.namespace];
    const result = await execute('helm', args, { env: connection.environment, timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024 });
    return result.stdout;
  }
  const reader = { kube, readLocalValues, readInstalledValues };
  await checkProviderArtifacts(reader, secrets, budget);
  const inspected = await privateScript(providerEventDisclosureScript, secrets);
  assert(inspected.checkedEvents > 0);
  outcomes.push({ check: 'keys absent from values, manifests, environment values, logs and events',
    result: 'PASS', checkedEvents: inspected.checkedEvents });
}

async function runProviderJourney() {
  // Save the wrong key privately so the collector can remove it from failure logs.
  const privateFileOptions = { mode: 0o600 };
  await writeFile(`${directory}/model-qualification-wrong-key`, wrongCredential, privateFileOptions);
  browser = await chromium.launch({ headless: true, channel: 'chromium' });
  step('owner sign-in', 'The owner must finish single sign-on into the fresh installation.');
  const ownerPage = await login('owner');
  step('admin invitation and sign-in', 'The separate admin must accept the owner invitation.');
  const admin = await invite(ownerPage, 'without-assistant', 'admin');
  step('member invitation and sign-in', 'The separate member must accept the owner invitation.');
  const member = await invite(ownerPage, 'member', 'member');
  step('Settings setup', 'Provider setup must finish before starting member chats.');
  await connect(budget ? ownerPage : admin.page);
  await runMemberJourney(ownerPage, admin, member);
  step('credential disclosure checks', 'No inspected artifact or event may disclose a credential.');
  await checkDisclosure();
  step('finish API disclosure inspections',
    'All response inspections must pass through browser shutdown.');
  await finishBrowserReplies(browser, responses, recordShutdownFailure);
  browser = undefined;
  const browserDisclosure = { check: stage.check, result: 'PASS',
    checkedReplies: responses.length };
  outcomes.push(browserDisclosure);
  const git = await execute('git', ['rev-parse', 'HEAD'], { cwd: root });
  await writeFile(`${output}/result.json`, JSON.stringify({ status: 'PASS', source: git.stdout.trim(),
    outcomes, paidCalls: 0, paidCents: 0 }, null, 2) + '\n');
  const completion = budget ? 'provider setup, charged turns and budget refusals'
    : 'provider Settings, refusal, private restart and member chats';
  console.log(`PASS packaged ${completion} at 1280/390`);
}

try {
  await mkdir(output, { recursive: true });
  if (budget) {
    step('verify qualification', 'The separate free stand-in must be reachable before setup.');
    await withBudgetQualification(kube, readRequestCount, runProviderJourney);
  } else {
    await runProviderJourney();
  }
} catch (error) {
  const failure = providerFailure(stage, error);
  outcomes.push(failure);
  const git = await execute('git', ['rev-parse', 'HEAD'], { cwd: root });
  const result = { status: 'FAIL', source: git.stdout.trim(), outcomes, paidCalls: 0, paidCents: 0 };
  const serialisedResult = JSON.stringify(result, null, 2) + '\n';
  await writeFile(`${output}/result.json`, serialisedResult);
  // Keep page content, credentials and local paths out of diagnostics.
  console.error(`FAIL packaged provider journey during ${failure.check}: ${failure.detail}`);
  process.exitCode = 1;
} finally {
  if (browser) {
    const closeBrowser = browser.close.bind(browser);
    try {
      await runShutdownStep('closing the browser', closeBrowser, recordShutdownFailure);
    } catch {
      console.error('FAIL while closing Chromium; inspect the claimed slot');
      process.exitCode = 1;
    }
  }
}
