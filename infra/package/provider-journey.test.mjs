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
import { providerJourneyCoverage } from './provider-journey-coverage.ts';
import { providerFailure, writeShutdownFailure } from './provider-failure.ts';
import { providerEventDisclosureScript, providerKeyModesScript, qualificationRequestCountScript,
  withBudgetQualification,
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
const wrongCredential = randomUUID();
const secrets = [wrongCredential];
const inspectBrowserBody = assertNoBrowserDisclosure.bind(undefined, secrets);
const responses = [];
const outcomes = [];
let setup;
let credential;
let browser;
let stage = { check: 'browser launch', detail: 'Chromium must launch for the packaged journey.' };

function step(check, detail) {
  stage = { check, detail };
}

const recordShutdownFailure = writeShutdownFailure.bind(
  undefined, `${directory}/browser-shutdown.log`, secrets);

async function kube(args) {
  const commandArgs = [...connection.args, '-n', owner.namespace, ...args];
  const options = {
    env: connection.environment,
    timeout: 180_000,
    maxBuffer: 4 * 1024 * 1024,
  };
  const result = await execute('kubectl', commandArgs, options);
  return result.stdout;
}

async function privateScript(script, input) {
  const args = [...connection.args, '-n', owner.namespace, 'exec', '-i', 'deployment/server',
    '-c', 'server', '--', 'node', '--input-type=module', '-e', script];
  const options = { env: connection.environment, timeout: 30_000 };
  const child = execFile('kubectl', args, options);
  const finished = once(child, 'exit');
  const serialisedInput = JSON.stringify(input);
  child.stdin.end(serialisedInput);
  let result = '';
  for await (const chunk of child.stdout) {
    result += chunk.toString();
  }
  const [exit] = await finished;
  assert.equal(exit, 0, 'Private inspection must finish without disclosing a key');
  return JSON.parse(result);
}

async function wrongKeyStatus() {
  const result = await privateScript(wrongKeyStatusScript, wrongCredential);
  assert.equal(result.status, 401, 'The same wrong credential receives HTTP 401 upstream');
  const outcome = {
    check: 'wrong credential receives HTTP 401 from the separate stand-in',
    result: 'PASS',
    status: result.status,
  };
  outcomes.push(outcome);
}

async function login(role) {
  const viewport = { width: 1280, height: 900 };
  const contextOptions = { viewport };
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  await watchBrowserReplies(page, origin, responses, inspectBrowserBody);
  page.setDefaultTimeout(30_000);
  const user = setup.users[role];
  assert(user, 'The claimed slot must have this separate test identity');
  await navigateWithReplies(page, origin, responses);
  const signInOptions = { name: 'Continue with single sign-on', exact: true };
  const signIn = page.getByRole('button', signInOptions);
  await signIn.click();
  const password = await readFile(user.passwordFile, 'utf8');
  secrets.push(password.trim());
  await completeProviderSignIn(page, user.login, password, origin, setup.issuer);
  return page;
}

async function capture(page, name, width) {
  const viewport = { width, height: width === 390 ? 844 : 900 };
  await page.setViewportSize(viewport);
  const bodyLocator = page.locator('body');
  const body = await bodyLocator.innerText();
  for (const secret of secrets) {
    assert(!body.includes(secret), 'Visible text disclosed a key');
  }
  const fields = page.locator('input[type=password], input[type=email]');
  const addresses = page.getByText(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu);
  const options = {
    path: `${output}/${name}-${width}.png`,
    fullPage: true,
    mask: [fields, addresses],
  };
  await page.screenshot(options);
}

async function screenshots(page, name) {
  for (const width of [1280, 390]) {
    await capture(page, name, width);
  }
  const viewport = { width: 1280, height: 900 };
  await page.setViewportSize(viewport);
}

async function invite(ownerPage, role, membershipRole) {
  const memberId = randomUUID();
  const user = setup.users[role];
  const loginParts = user.login.split('@');
  const userName = loginParts[0];
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
  const joinedResult = await joined.json();
  assert.equal(joinedResult.status, 'joined');
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

async function openProviderSettings(admin) {
  step('open Settings', 'The person setting up the provider must reach Models & providers.');
  await navigateWithReplies(admin, `${origin}/workspace`, responses);
  const settingsOptions = { name: 'Settings', exact: true };
  const settings = admin.getByRole('link', settingsOptions);
  await settings.click();
  const modelsOptions = { name: /Models/ };
  const models = admin.getByRole('link', modelsOptions);
  await models.click();
  const headingOptions = { name: 'Models & providers', exact: true };
  const heading = admin.getByRole('heading', headingOptions);
  await heading.waitFor();
  await screenshots(admin, budget ? 'owner-settings' : 'admin-settings');
}

async function checkNewKeyEntry(admin) {
  step('create provider connection', 'The saved connection must advance to its Key step.');
  await createProviderConnection(admin, 'Package free provider');
  const setup = providerSetup(admin);
  for (const width of [1280, 390]) {
    step(`new-key field at ${width}px`, 'Setup must offer one visible new-key field.');
    const viewport = { width, height: width === 390 ? 844 : 900 };
    await admin.setViewportSize(viewport);
    const keyOptions = { exact: true };
    const key = setup.getByLabel('API key Required', keyOptions);
    assert.equal(await key.count(), 1, 'Setup offers exactly one new-key field');
    assert.equal(await key.isVisible(), true, 'A person can enter a new key');
    await capture(admin, 'new-key-entry', width);
  }
  const viewport = { width: 1280, height: 900 };
  await admin.setViewportSize(viewport);
}

async function checkWrongProviderKey(admin) {
  step('save wrong synthetic key', 'Saving the key must advance to the Verify step.');
  await saveProviderKey(admin, wrongCredential);
  const reachabilityOptions = { name: 'Check provider reachability', exact: true };
  const reachability = admin.getByRole('button', reachabilityOptions);
  await reachability.waitFor();
  const inventory = await readJourneyApi(admin, `${origin}/api/org/providers`);
  const providers = await inventory.json();
  const providerId = providers.rows[0].providerId;
  const providerUrl = `${origin}/api/org/providers/${providerId}`;
  step('wrong-key reachability', 'Verification must report failed reachability for the wrong key.');
  await verifyProvider(admin, providerUrl, 'Check provider reachability', 'fail');
  const setup = providerSetup(admin);
  const factsOptions = { name: 'Provider verification facts', exact: true };
  const facts = setup.getByRole('region', factsOptions);
  const failureOptions = { exact: true };
  const failure = facts.getByText('The test failed. Nothing else changed.', failureOptions);
  await failure.waitFor();
  await screenshots(admin, 'wrong-key-refused');
  step('wrong-key HTTP refusal', 'The private wrong-key probe must complete and return HTTP 401.');
  await wrongKeyStatus();
  const outcome = { check: 'wrong key refused without disclosure', result: 'PASS' };
  outcomes.push(outcome);
  return { providerId, providerUrl, facts };
}

async function checkRightProviderKey(admin, providerUrl, facts) {
  const setup = providerSetup(admin);
  const footer = setup.locator('footer');
  const backOptions = { name: 'Back', exact: true };
  const back = footer.getByRole('button', backOptions);
  await back.click();
  step('save right synthetic key', 'Saving the replacement must advance to the Verify step.');
  await saveProviderKey(admin, credential);
  step('right-key reachability', 'Verification must report successful provider reachability.');
  await verifyProvider(admin, providerUrl, 'Check provider reachability', 'pass');
  step('quoted model test', 'The agreed quoted test must produce a successful model answer.');
  const priceOptions = { name: 'Read current price', exact: true };
  const price = admin.getByRole('button', priceOptions);
  await price.click();
  const agreementOptions = { name: /I agree to one priced test request/ };
  const agreement = admin.getByRole('checkbox', agreementOptions);
  await agreement.check();
  await screenshots(admin, 'quoted-test');
  await verifyProvider(admin, providerUrl, 'Run priced test', 'pass');
  const answer = facts.getByText(/ answered$/u);
  await answer.waitFor();
  await screenshots(admin, 'model-test-passed');
}

async function selectProviderModels(admin, providerId) {
  const nextOptions = { name: 'Next', exact: true };
  const next = admin.getByRole('button', nextOptions);
  await next.click();
  step('model selection', 'The selected chat models must finish applying.');
  const solOptions = { name: /gpt-6\.1-sol/ };
  const sol = admin.getByRole('checkbox', solOptions);
  await sol.check();
  const lunaOptions = { name: /gpt-6-luna/ };
  const luna = admin.getByRole('checkbox', lunaOptions);
  await luna.check();
  await next.click();
  await waitForModels(admin, providerId);
  await next.click();
  const modelsOptions = { name: 'Go to Models', exact: true };
  const models = admin.getByRole('button', modelsOptions);
  await models.click();
}

async function switchOnProviderChats(admin, providerId) {
  step('select chat default', 'Selecting the chat default must save its model binding.');
  const chat = await selectChatDefault(admin, origin, providerId, 'gpt-6.1-sol');
  step('switch on member chats', 'Drained provider admission must allow member chats to switch on.');
  const pauseOptions = { name: 'Pause new calls', exact: true };
  const pause = chat.getByRole('button', pauseOptions);
  await pause.click();
  const switchOnOptions = { name: 'Switch on member chats', exact: true };
  const switchOn = chat.getByRole('button', switchOnOptions);
  await switchOn.click();
  const statusOptions = { exact: true };
  const status = chat.getByText('Member chats switched on', statusOptions);
  await status.waitFor();
  await screenshots(admin, 'provider-switched-on');
  const outcome = { check: 'Settings connects, tests, selects and switches on', result: 'PASS' };
  outcomes.push(outcome);
}

async function connect(admin) {
  await openProviderSettings(admin);
  await checkNewKeyEntry(admin);
  const verification = await checkWrongProviderKey(admin);
  await checkRightProviderKey(admin, verification.providerUrl, verification.facts);
  await selectProviderModels(admin, verification.providerId);
  await switchOnProviderChats(admin, verification.providerId);
}

async function privateModes() {
  const args = ['exec', 'deployment/server', '-c', 'server', '--', 'node',
    '--input-type=module', '-e', providerKeyModesScript];
  const output = await kube(args);
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
  const podArgs = ['get', 'pods', '-l', 'app=server', '-o', 'json'];
  const podJson = await kube(podArgs);
  const pod = JSON.parse(podJson);
  const oldUid = pod.items[0].metadata.uid;
  const logArgs = ['logs', pod.items[0].metadata.name, '--all-containers=true',
    '--prefix=true', '--tail=-1'];
  const logs = await kube(logArgs);
  for (const secret of secrets) {
    assert(!logs.includes(secret), 'Setup logs disclosed a key');
  }
  const logOptions = { mode: 0o600 };
  await writeFile(`${directory}/provider-before-recreation.log`, logs, logOptions);
  const logOutcome = { check: 'setup logs checked before Pod recreation', result: 'PASS' };
  outcomes.push(logOutcome);
  step('recreate provider Pod', 'The replacement server Pod must become ready.');
  const deleteArgs = ['delete', 'pod', pod.items[0].metadata.name, '--wait=true'];
  await kube(deleteArgs);
  const rolloutArgs = ['rollout', 'status', 'deployment/server', '--timeout=180s'];
  await kube(rolloutArgs);
  const replacedJson = await kube(podArgs);
  const replaced = JSON.parse(replacedJson);
  assert.notEqual(replaced.items[0].metadata.uid, oldUid);
  step('private modes after recreation', 'Recreation must preserve private modes and credential bytes.');
  const after = await privateModes();
  assert.deepEqual(after, before, 'Private modes and synthetic credential bytes survive recreation');
  const outcome = {
    check: 'Pod recreation preserves synthetic credential bytes and modes',
    result: 'PASS',
    directoryModeBefore: '0700',
    directoryModeAfter: '0700',
    fileModeBefore: '0600',
    fileModeAfter: '0600',
    keys: after.keys.length,
  };
  outcomes.push(outcome);
}

async function memberChats(member) {
  for (const width of [1280, 390]) {
    step(`member chat at ${width}px`, 'A member message must receive the expected free-provider reply.');
    const viewport = { width, height: width === 390 ? 844 : 900 };
    await member.setViewportSize(viewport);
    await navigateWithReplies(member, `${origin}/workspace`, responses);
    const composerOptions = { name: 'Message your agent' };
    const composer = member.getByRole('textbox', composerOptions);
    const waitOptions = { timeout: 120_000 };
    await composer.waitFor(waitOptions);
    await member.keyboard.press('Control+n');
    const draftOptions = { exact: true };
    const draft = member.getByText('Draft', draftOptions);
    await draft.waitFor();
    await composer.fill('Say hello briefly.');
    await composer.press('Enter');
    const replyOptions = { name: 'Agent reply', exact: true };
    const reply = member.getByRole('article', replyOptions);
    const doneOptions = { exact: true };
    const done = reply.getByText('Done', doneOptions);
    await done.waitFor(waitOptions);
    const content = reply.locator('.prose');
    assert.equal(await content.innerText(), 'Hello from your computer.');
    await capture(member, 'member-chat', width);
    const outcome = { check: `member chat at ${width}px`, result: 'PASS' };
    outcomes.push(outcome);
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
    const options = {
      env: connection.environment,
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    };
    const result = await execute('helm', args, options);
    return result.stdout;
  }
  const reader = { kube, readLocalValues, readInstalledValues };
  const logs = await checkProviderArtifacts(reader, secrets);
  const inspected = await privateScript(providerEventDisclosureScript, secrets);
  assert(inspected.checkedEvents > 0);
  const outcome = {
    check: 'keys absent from local and installed values, manifests, logs and events',
    result: 'PASS',
    ...logs,
    checkedEvents: inspected.checkedEvents,
  };
  outcomes.push(outcome);
}

async function runProviderJourney() {
  step('read qualification settings', 'The claimed slot must have its free test accounts and key.');
  const savedSetup = await readFile(`${directory}/zitadel.json`, 'utf8');
  setup = JSON.parse(savedSetup);
  const savedCredential = await readFile(`${directory}/model-qualification-key`, 'utf8');
  credential = savedCredential.trim();
  assert(credential, 'The qualification key must be present');
  secrets.push(credential);

  // Save the wrong key privately so the collector can remove it from failure logs.
  const privateFileOptions = { mode: 0o600 };
  await writeFile(`${directory}/model-qualification-wrong-key`, wrongCredential, privateFileOptions);
  step('browser launch', 'Chromium must launch for the packaged journey.');
  const browserOptions = { headless: true, channel: 'chromium' };
  browser = await chromium.launch(browserOptions);
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
  const expectedReplies = providerJourneyCoverage(ownerPage, admin.page, member.page, budget);
  await finishBrowserReplies(browser, responses, recordShutdownFailure, expectedReplies);
  browser = undefined;
  const browserDisclosure = { check: stage.check, result: 'PASS',
    checkedReplies: responses.length };
  outcomes.push(browserDisclosure);
  const gitArgs = ['rev-parse', 'HEAD'];
  const gitOptions = { cwd: root };
  const git = await execute('git', gitArgs, gitOptions);
  const result = {
    status: 'PASS',
    source: git.stdout.trim(),
    outcomes,
    paidCalls: 0,
    paidCents: 0,
  };
  const serialisedResult = JSON.stringify(result, null, 2) + '\n';
  await writeFile(`${output}/result.json`, serialisedResult);
  const completion = budget ? 'provider setup, charged turns and budget refusals'
    : 'provider Settings, refusal, private restart and member chats';
  console.log(`PASS packaged ${completion} at 1280/390`);
}

try {
  const directoryOptions = { recursive: true };
  await mkdir(output, directoryOptions);
  if (budget) {
    step('verify qualification', 'The separate free stand-in must be reachable before setup.');
    await withBudgetQualification(kube, readRequestCount, runProviderJourney);
  } else {
    await runProviderJourney();
  }
} catch (error) {
  const failure = providerFailure(stage, error);
  outcomes.push(failure);
  const gitArgs = ['rev-parse', 'HEAD'];
  const gitOptions = { cwd: root };
  const git = await execute('git', gitArgs, gitOptions);
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
