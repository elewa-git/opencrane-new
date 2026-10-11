/// <reference lib="dom" />
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Locator, Page, Request as BrowserRequest, Response as BrowserResponse }
  from 'playwright';
import type { EventStore } from '@opencrane/event-store';
import { grantStream } from '@opencrane/authz';
import { models, ownershipSubject } from '@opencrane/models';
import { modelForTask } from '@opencrane/models/routing';
import { readEvents } from '@opencrane/projections';

export type Phase4Status = 'PASS' | 'FAIL' | 'NOT PROVEN' | 'PAID / NOT RUN';
export type Phase4Assertion = {
  id: string;
  status: Phase4Status;
  statement: string;
  evidence: Record<string, string | number | boolean | string[]>;
  screenshots: string[];
};
type AppendFixture = (
  type: string,
  subject: string,
  data: Record<string, unknown>,
  source?: string,
) => Promise<void>;
type BrowserPhase4Options = {
  ownerPage: Page;
  memberPages: Page[];
  origin: string;
  directory: string;
  attempt: string;
  silo: string;
  modelStubPort: string;
  secondaryStack: boolean;
  store: EventStore;
  append: AppendFixture;
  assertions: Phase4Assertion[];
};
type GroupRow = {
  groupId: string;
  name: string;
  members: Array<{ memberId: string; displayName: string }>;
  access: { grants: Array<{ resourceType: string; resourceId: string }> };
};
type DirectConversation = {
  conversationId: string;
  mode: string;
  participantIds: string[];
};

const ownerId = 'zitadel-owner';
const memberId = 'zitadel-member';
const placeholderKey = 'journey-placeholder-not-a-provider-key';

export async function browserPhase4(options: BrowserPhase4Options): Promise<void> {
  const ownerPage = options.ownerPage;
  const memberMobile = findPage(options.memberPages, 390);
  const memberDesktop = findPage(options.memberPages, 1280);
  const attemptDirectory = resolve(options.directory, 'p4-journey', options.attempt);
  await mkdir(attemptDirectory, { recursive: true });
  addNonRunRows(options.assertions, options.attempt);

  const group = await qualifyGroups(options, ownerPage, attemptDirectory);
  const assistantId = await qualifySharedAssistant(options, ownerPage, memberMobile, memberDesktop,
    attemptDirectory, group);
  await qualifyGroupRemoval(options, ownerPage, memberMobile, attemptDirectory, group,
    assistantId);
  await qualifyDirectChat(options, ownerPage, memberMobile, memberDesktop,
    attemptDirectory);
  await qualifyProvider(options, ownerPage, attemptDirectory);
  if (options.secondaryStack) {
    await qualifyOwnershipTransfer(options, ownerPage, attemptDirectory);
  }

}

function findPage(pages: Page[], width: number): Page {
  const page = pages.find(matchesViewport.bind(null, width));
  assert(page, `A signed-in member page at ${width}px is required`);
  return page;
}

function matchesViewport(width: number, page: Page): boolean {
  return page.viewportSize()?.width === width;
}

async function qualifyGroups(
  options: BrowserPhase4Options,
  page: Page,
  output: string,
): Promise<{ groupId: string; groupName: string; modelId: string }> {
  const uniqueName = randomUUID();
  const groupName = `Journey group ${uniqueName}`;
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${options.origin}/org/people`);
  await page.getByRole('tab', { name: /Groups/ }).click();
  await page.locator('#group-search').waitFor();
  const groupResponse = await page.request.get(`${options.origin}/api/groups`);
  assert.equal(groupResponse.status(), 200);
  const groupBody = await groupResponse.json() as { rows: GroupRow[] };
  const groupListLoaded = await groupListMatchesServer(page, groupBody.rows);
  const listScreens = await captureAtBothWidths(page, output, 'groups-list');
  const groupListEvidence = { groupCount: groupBody.rows.length };
  record(options.assertions, 'groups.list', groupListLoaded,
    'The group page shows the names returned by the server.', groupListEvidence, listScreens);

  await page.locator('#group-search').fill('no group has this name');
  await page.getByRole('heading', { name: /No groups match/ }).waitFor();
  await page.locator('#group-search').fill('');
  await page.getByRole('button', { name: 'New group', exact: true }).first().click();
  await page.locator('#group-name').fill(groupName);
  await page.getByRole('button', { name: 'Create group', exact: true }).click();
  await page.getByText(new RegExp(`Group “${escapeRegExp(groupName)}” created`)).waitFor();
  const createdLink = page.getByRole('link', { name: 'Open group', exact: true });
  const detailUrl = await createdLink.getAttribute('href');
  assert(detailUrl);
  const groupIdFromUrl = detailUrl.split('/').at(-1);
  assert(groupIdFromUrl);
  const createdScreens = await captureAtBothWidths(page, output, 'groups-created');
  const createdEvidence = { groupId: groupIdFromUrl, groupName };
  record(options.assertions, 'groups.create', await createdLink.isVisible(),
    'The Owner creates a local group and can open its detail page.',
    createdEvidence, createdScreens);

  await addMember(options, page, groupIdFromUrl);
  const modelId = currentModelId();
  // Keep this fixture: the server has no command for granting a model to a group.
  const groupGrant = {
    resourceType: 'model', resourceId: modelId, granteeKind: 'team',
    granteeId: groupIdFromUrl, grantedBy: ownerId,
  };
  await options.append('grant.given', grantStream('model', modelId), groupGrant);
  await waitForGroup(page, groupIdFromUrl, hasGroupGrant.bind(null, modelId));

  await page.goto(`${options.origin}/org/people`);
  await page.getByRole('tab', { name: /Groups/ }).click();
  await page.locator('#group-search').fill(groupName);
  const matchingGroupRow = page.locator('.group-row').filter({ hasText: groupName });
  await matchingGroupRow.waitFor();
  const searchScreens = await captureAtBothWidths(page, output, 'groups-search');
  const searchEvidence = { groupName };
  record(options.assertions, 'groups.search', await matchingGroupRow.isVisible(),
    'Searching by the new group name finds its row at 1280px and 390px.',
    searchEvidence, searchScreens);

  await page.goto(`${options.origin}${detailUrl}`);
  await page.getByRole('heading', { name: groupName, exact: true }).waitFor();
  const detailScreens = await captureAtBothWidths(page, output, 'groups-detail');
  const detailText = await page.locator('main').innerText();
  const detailEvidence = { memberId, modelId };
  record(options.assertions, 'groups.detail',
    detailText.includes(memberId) && detailText.includes(modelId),
    'Group detail shows the member and model grant.', detailEvidence, detailScreens);

  return { groupId: groupIdFromUrl, groupName, modelId };
}

async function groupListMatchesServer(page: Page, groups: GroupRow[]): Promise<boolean> {
  if (groups.length === 0) {
    const emptyState = page.getByRole('heading', { name: 'No groups yet', exact: true });
    await emptyState.waitFor({ state: 'visible' });
    return await emptyState.isVisible();
  }
  for (const group of groups) {
    const row = page.locator('.group-row').filter({ hasText: group.name });
    await row.waitFor({ state: 'visible' });
    if (!await row.isVisible()) return false;
  }
  return true;
}

async function qualifyGroupRemoval(
  options: BrowserPhase4Options,
  page: Page,
  memberPage: Page,
  output: string,
  group: { groupId: string; groupName: string; modelId: string },
  assistantId: string,
): Promise<void> {
  const groupId = group.groupId;
  const groupName = group.groupName;
  await page.goto(`${options.origin}/org/people/groups/${groupId}`);
  const reviewScreens = await openRemovalReviewAtBothWidths(page, output, groupName);
  const review = page.getByRole('dialog');
  const reviewText = await review.innerText();
  const reviewCopyIsClear = reviewText.includes('private conversations and memory')
    && reviewText.includes('within two seconds');
  const reviewEvidence = {};
  record(options.assertions, 'groups.removal_review', reviewCopyIsClear,
    'Removal review explains what access ends and when.', reviewEvidence, reviewScreens);
  await review.getByRole('button', { name: `Remove ${memberId} from ${groupName}` }).click();
  await page.getByText(`Removed ${memberId} from ${groupName}`).waitFor();
  await waitForGroup(page, groupId, memberIsAbsent);
  const assistantIsHidden = await waitForAssistantToBeHidden(
    memberPage, options.origin, assistantId,
  );
  const removedScreens = await captureAtBothWidths(page, output, 'groups-removed');
  const removalEvidence = { removedMemberId: memberId,
    sharedAssistantHidden: assistantIsHidden };
  record(options.assertions, 'groups.remove_member', assistantIsHidden,
    'The removed member no longer sees the shared assistant through the server.',
    removalEvidence, removedScreens);

}

async function waitForAssistantToBeHidden(
  page: Page,
  origin: string,
  assistantId: string,
): Promise<boolean> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response = await page.request.get(`${origin}/api/assistants`);
    assert.equal(response.status(), 200);
    const body = await response.json() as { rows: AssistantRow[] };
    if (!body.rows.some(hasAssistantId.bind(null, assistantId))) return true;
    await delay(250);
  }
  return false;
}

function hasAssistantId(
  assistantId: string,
  assistant: AssistantRow,
): boolean {
  return assistant.assistantId === assistantId;
}

async function addMember(
  options: BrowserPhase4Options,
  page: Page,
  groupId: string,
): Promise<void> {
  const response = await page.request.post(`${options.origin}/api/groups/${groupId}`, {
    headers: { origin: options.origin },
    data: addMemberCommand(),
  });
  assert.equal(response.status(), 200, 'The existing group command must add the seeded member');
  await waitForGroup(page, groupId, memberIsPresent);
}

function addMemberCommand(): Record<string, string> {
  return { action: 'add', commandId: `journey-add-${randomUUID()}`, memberId };
}

async function waitForGroup(
  page: Page,
  groupId: string,
  check: (group: GroupRow) => boolean,
): Promise<GroupRow> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response = await page.request.get(`${new URL(page.url()).origin}/api/groups/${groupId}`);
    if (response.ok()) {
      const body = await response.json() as { rows: GroupRow[] };
      const row = body.rows[0];
      if (row && check(row)) return row;
    }
    await delay(250);
  }
  throw new Error(`Group ${groupId} did not reach the requested state`);
}

function memberIsPresent(group: GroupRow): boolean {
  return group.members.some(hasMemberId);
}

function hasMemberId(member: GroupRow['members'][number]): boolean {
  return member.memberId === memberId;
}

function memberIsAbsent(group: GroupRow): boolean {
  return !group.members.some(hasMemberId);
}

function hasGroupGrant(modelId: string, group: GroupRow): boolean {
  return group.access.grants.some(hasModelGrant.bind(null, modelId));
}

function hasModelGrant(modelId: string, grant: GroupRow['access']['grants'][number]): boolean {
  return grant.resourceType === 'model' && grant.resourceId === modelId;
}

function currentModelId(): string {
  const modelId = modelForTask('chat_turn');
  const activeModel = models.find(matchesActiveModel.bind(null, modelId));
  assert(activeModel, 'The chat turn model must be active in the model registry');
  return modelId;
}

function matchesActiveModel(
  modelId: string,
  model: (typeof models)[number],
): boolean {
  return model.id === modelId && !model.retired;
}

async function openRemovalReviewAtBothWidths(
  page: Page,
  output: string,
  groupName: string,
): Promise<string[]> {
  const screenshots: string[] = [];
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const removeButton = page.getByRole('button', {
      name: `Remove ${memberId} from ${groupName}`,
    });
    await removeButton.click();
    await page.getByRole('dialog').waitFor();
    screenshots.push(await screenshot(page, output, `groups-removal-review-${width}`));
    await page.getByRole('button', { name: 'Cancel', exact: true }).last().click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', {
    name: `Remove ${memberId} from ${groupName}`,
  }).click();
  await page.getByRole('dialog').waitFor();
  return screenshots;
}

async function qualifySharedAssistant(
  options: BrowserPhase4Options,
  ownerPage: Page,
  memberMobile: Page,
  memberDesktop: Page,
  output: string,
  group: { groupId: string; groupName: string; modelId: string },
): Promise<string> {
  await ownerPage.setViewportSize({ width: 1280, height: 900 });
  await ownerPage.goto(`${options.origin}/org/people/groups/${group.groupId}/assistants/new`);
  await ownerPage.getByRole('heading', { name: 'Create a shared assistant' }).waitFor();
  const assistantName = `Shared journey ${randomUUID()}`;
  await ownerPage.locator('#assistant-name').fill(assistantName);
  const modelChoice = ownerPage.getByRole('checkbox', {
    name: `Model ${group.modelId}`,
    exact: true,
  });
  await modelChoice.check();
  const setupScreens = await captureAtBothWidths(ownerPage, output, 'shared-assistant-create');
  const setupText = await ownerPage.locator('main').innerText();
  const setupEvidence = { groupName: group.groupName, payerGroup: group.groupId,
    modelId: group.modelId };
  record(options.assertions, 'shared_assistant.admin_create',
    setupText.includes(group.groupName) && setupText.includes('Paying group')
      && setupText.includes('Memory is not included'),
    'The admin can choose this group, its payer and its model grant.',
    setupEvidence, setupScreens);

  await ownerPage.getByRole('button', { name: 'Review assistant' }).click();
  const review = ownerPage.getByRole('dialog');
  const reviewScreens = await captureAtBothWidths(ownerPage, output, 'shared-assistant-review');
  const reviewText = await review.innerText();
  const assistantReviewEvidence = { payerGroup: group.groupId };
  record(options.assertions, 'shared_assistant.review',
    reviewText.includes('Fixed payer') && reviewText.includes(group.groupName),
    'The review names the fixed paying group before the assistant is created.',
    assistantReviewEvidence, reviewScreens);
  const createRequestPromise = ownerPage.waitForRequest(isAssistantCreateRequest);
  const createResponsePromise = ownerPage.waitForResponse(isAssistantCreateResponse);
  await review.getByRole('button', { name: 'Create assistant', exact: true }).click();
  const createRequest = await createRequestPromise;
  const createCommand = readAssistantCreateCommand(createRequest);
  const createResponse = await createResponsePromise;
  const responseScreens = await captureAtBothWidths(ownerPage, output,
    'shared-assistant-create-response');
  const createEvidence = { responseStatus: createResponse.status(),
    assistantId: createCommand.assistantId, commandKeys: createCommand.keys,
    hasStage: createCommand.keys.includes('stage'), groupId: createCommand.groupId,
    payingGroupId: createCommand.payingGroupId, name: createCommand.name,
    grantIds: createCommand.grantIds };
  record(options.assertions, 'shared_assistant.create_request', createResponse.status() === 200,
    'The server accepts the assistant create request from the review.',
    createEvidence, responseScreens);
  await waitForAssistantChangeToApply(ownerPage);
  const created = await waitForReadyAssistant(ownerPage, assistantName,
    createCommand.assistantId, options.store);
  const createdScreens = await captureAtBothWidths(ownerPage, output, 'shared-assistant-created');
  const createdData = await createdAssistantEvent(options.store, options.silo,
    createCommand.assistantId);
  const createdMatchesReview = createdData.ownerId === group.groupId
    && createdData.payingGroupId === group.groupId
    && createdData.name === assistantName
    && createdData.grants.some(hasSelectedModel.bind(null, group.modelId));
  const createdEvidence = { assistantId: createCommand.assistantId,
    payerGroup: createdData.payingGroupId, ownerGroup: createdData.ownerId,
    creationMatchesReview: createdMatchesReview };
  record(options.assertions, 'shared_assistant.created', createdMatchesReview,
    'The saved assistant event names the owner group, payer, model and display name.',
    createdEvidence, createdScreens);
  const readyEvidence = { assistantId: created.assistantId,
    status: created.status ?? 'unknown' };
  record(options.assertions, 'shared_assistant.computer_ready_for_selection',
    created.status === 'ready',
    'The assistant appears in the member selection list after its computer record is ready.',
    readyEvidence, createdScreens);

  await memberMobile.goto(`${options.origin}/workspace/shared`);
  await memberMobile.getByRole('button', {
    name: new RegExp(`Choose ${escapeRegExp(assistantName)}`),
  }).waitFor();
  const eligibleScreens = await captureAtBothWidths(
    memberMobile, output, 'shared-assistant-choice',
  );
  const pickerText = await memberMobile.locator('main').innerText();
  const choiceEvidence = { assistantId: created.assistantId, assistantName };
  record(options.assertions, 'shared_assistant.member_choice',
    pickerText.includes('Private to you') && pickerText.includes('transcript is private'),
    'The member can choose the shared assistant for a private session.',
    choiceEvidence, eligibleScreens);

  await memberMobile.getByRole('button', {
    name: new RegExp(`Choose ${escapeRegExp(assistantName)}`),
  }).click();
  const selection = memberMobile.getByRole('dialog');
  const sessionRequestPromise = memberMobile.waitForRequest(isPrivateSessionRequest);
  const sessionResponsePromise = memberMobile.waitForResponse(isPrivateSessionResponse);
  await selection.getByRole('button', { name: 'Start session', exact: true }).click();
  const sessionRequest = await sessionRequestPromise;
  const sessionCommand = readPrivateSessionCommand(sessionRequest);
  const sessionResponse = await sessionResponsePromise;
  const sessionStatus = sessionResponse.status();
  const sessionEvidence = { assistantId: sessionCommand.assistantId,
    payingGroupId: sessionCommand.payingGroupId,
    conversationId: sessionCommand.conversationId, responseStatus: sessionStatus };
  assert.equal(sessionStatus, 200, 'The server must record the private session');
  await waitForPrivateSessionToApply(memberMobile);
  const sessionScreens = await captureAtBothWidths(memberMobile, output,
    'shared-assistant-session-response');
  record(options.assertions, 'shared_assistant.session_recorded', sessionStatus === 200,
    'The server records the member’s private session with this shared assistant.',
    sessionEvidence, sessionScreens);
  const privateUrl = memberMobile.url();
  const prompt = `Private shared reply ${randomUUID()}`;
  await memberMobile.getByRole('textbox', { name: 'Message your agent' }).fill(prompt);
  await memberMobile.getByRole('button', { name: 'Send message', exact: true }).click();
  await memberMobile.getByText(prompt, { exact: true }).waitFor();
  await waitForSharedAssistantReply(memberMobile, output);
  const privateScreens = await captureAtBothWidths(memberMobile, output,
    'shared-assistant-private-chat');
  const privateText = await memberMobile.locator('main').innerText();
  const savedSession = await privateSessionEvent(options.store, options.silo,
    sessionCommand.conversationId);
  const savedSessionMatchesChoice = savedSession.createdBy === memberId
    && savedSession.assistantId === created.assistantId
    && savedSession.payingGroupId === group.groupId;
  const privateChatEvidence = { assistantId: savedSession.assistantId,
    payingGroupId: savedSession.payingGroupId, createdBy: savedSession.createdBy,
    privateUrl };
  record(options.assertions, 'shared_assistant.private_chat',
    privateText.includes('Private session') && privateText.includes(prompt)
      && savedSessionMatchesChoice,
    'The member loads a private chat, sends a prompt and sees a reply.',
    privateChatEvidence, privateScreens);
  return created.assistantId;
}

async function waitForSharedAssistantReply(page: Page, output: string): Promise<void> {
  const reply = page.getByText('Hello from your computer.', { exact: true });
  try {
    await reply.waitFor({ timeout: 120_000 });
  } catch (error) {
    const failureScreenshot = resolve(output, 'shared-assistant-private-chat-failure.png');
    await page.screenshot({ path: failureScreenshot, fullPage: false });
    const mainText = await page.locator('main').innerText();
    throw new Error(`The private chat did not show the stub reply. Screen text: `
      + mainText.slice(0, 500), { cause: error });
  }
}

type AssistantRow = {
  assistantId: string;
  name?: string;
  payingGroupId?: string;
  status?: string;
};

type AssistantCreateCommand = {
  commandId: string;
  assistantId: string;
  groupId: string;
  payingGroupId: string;
  name: string;
  grantIds: string[];
  keys: string[];
};

type PrivateSessionCommand = {
  assistantId: string;
  payingGroupId: string;
  conversationId: string;
};

type SavedPrivateSession = {
  createdBy: string;
  assistantId: string;
  payingGroupId: string;
};

type CreatedAssistantData = {
  ownerId: string;
  payingGroupId: string;
  name: string;
  grants: Array<{ resourceType: string; resourceId: string }>;
};

function isAssistantCreateRequest(request: BrowserRequest): boolean {
  const url = new URL(request.url());
  return request.method() === 'POST' && url.pathname === '/api/assistants';
}

function isAssistantCreateResponse(response: BrowserResponse): boolean {
  const url = new URL(response.url());
  return response.request().method() === 'POST' && url.pathname === '/api/assistants';
}

function isPrivateSessionRequest(request: BrowserRequest): boolean {
  const url = new URL(request.url());
  if (request.method() !== 'POST' || url.pathname !== '/api/conversations') return false;
  const body = request.postDataJSON() as Record<string, unknown>;
  return body['mode'] === 'agent_session';
}

function isPrivateSessionResponse(response: BrowserResponse): boolean {
  const url = new URL(response.url());
  return response.request().method() === 'POST' && url.pathname === '/api/conversations';
}

function readPrivateSessionCommand(request: BrowserRequest): PrivateSessionCommand {
  const body = request.postDataJSON() as Record<string, unknown>;
  assert(typeof body['assistantId'] === 'string');
  assert(typeof body['payingGroupId'] === 'string');
  assert(typeof body['conversationId'] === 'string');
  return { assistantId: body['assistantId'], payingGroupId: body['payingGroupId'],
    conversationId: body['conversationId'] };
}

async function privateSessionEvent(
  store: EventStore,
  silo: string,
  conversationId: string,
): Promise<SavedPrivateSession> {
  for await (const stored of store.readStream(`conversation-${conversationId}`)) {
    if (stored.event.silo !== silo || stored.event.type !== 'conversation.created') continue;
    const data = stored.event.data as SavedPrivateSession;
    return data;
  }
  throw new Error(`Private conversation ${conversationId} has no saved creation event`);
}

async function waitForPrivateSessionToApply(page: Page): Promise<void> {
  const deadline = Date.now() + 120_000;
  const statusButton = page.getByRole('button', { name: /Check status|Checking/ });
  while (!page.url().includes('/workspace?conversation=')) {
    if (Date.now() >= deadline) {
      const notice = await page.locator('main').innerText();
      throw new Error(`The private session did not open; chooser said: ${notice}`);
    }
    await clickStatusWhenEnabled(statusButton);
    await delay(1_000);
  }
  await page.waitForLoadState('domcontentloaded');
  await page.getByText('Private session', { exact: true }).waitFor({ timeout: 90_000 });
}

function readAssistantCreateCommand(request: BrowserRequest): AssistantCreateCommand {
  const body = request.postDataJSON() as Record<string, unknown>;
  assert(typeof body['commandId'] === 'string');
  assert(typeof body['assistantId'] === 'string');
  assert(typeof body['groupId'] === 'string');
  assert(typeof body['payingGroupId'] === 'string');
  assert(typeof body['name'] === 'string');
  assert(Array.isArray(body['grants']));
  const grants = body['grants'] as Array<Record<string, unknown>>;
  const grantIds = grants.map(grantResourceId);
  const keys = Object.keys(body).sort();
  return { commandId: body['commandId'], assistantId: body['assistantId'],
    groupId: body['groupId'], payingGroupId: body['payingGroupId'], name: body['name'],
    grantIds, keys };
}

function grantResourceId(grant: Record<string, unknown>): string {
  const resourceType = typeof grant['resourceType'] === 'string'
    ? grant['resourceType'] : 'unknown';
  const resourceId = typeof grant['resourceId'] === 'string'
    ? grant['resourceId'] : 'unknown';
  return `${resourceType}:${resourceId}`;
}

async function createdAssistantEvent(
  store: EventStore,
  silo: string,
  assistantId: string,
): Promise<CreatedAssistantData> {
  const head = await store.head();
  assert(head, 'The event log must contain the assistant creation');
  for await (const row of readEvents(store, 1, head)) {
    if (row.event.silo !== silo || row.event.type !== 'assistant.created') continue;
    const data = row.event.data as CreatedAssistantData & { assistantId: string };
    if (data.assistantId === assistantId) return data;
  }
  throw new Error(`Assistant ${assistantId} has no saved creation event`);
}

function hasSelectedModel(
  modelId: string,
  grant: CreatedAssistantData['grants'][number],
): boolean {
  return grant.resourceType === 'model' && grant.resourceId === modelId;
}

async function assistantRows(page: Page): Promise<AssistantRow[]> {
  const response = await page.request.get(`${new URL(page.url()).origin}/api/assistants`);
  assert.equal(response.status(), 200);
  const body = await response.json() as { rows: AssistantRow[] };
  return body.rows;
}

async function waitForReadyAssistant(
  page: Page,
  name: string,
  assistantId: string,
  store: EventStore,
): Promise<AssistantRow> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const rows = await assistantRows(page);
    const assistant = rows.find(matchesAssistant.bind(null, assistantId, name));
    if (assistant?.status === 'ready') return assistant;
    await delay(500);
  }
  const eventTypes: string[] = [];
  for await (const stored of store.readStream(`computer-${assistantId}`)) {
    eventTypes.push(stored.event.type);
  }
  throw new Error(`The shared assistant ${name} was not ready; computer events: `
    + (eventTypes.join(', ') || 'none'));
}

async function waitForAssistantChangeToApply(page: Page): Promise<void> {
  const timeoutAt = Date.now() + 120_000;
  const appliedMessage = 'The assistant is recorded and its group access link is current.';
  const statusButton = page.getByRole('button', { name: /Check status|Checking/ });
  while (Date.now() < timeoutAt) {
    const pageText = await page.locator('main').innerText();
    if (pageText.includes(appliedMessage)) return;
    if (await statusButton.count()) {
      await clickStatusWhenEnabled(statusButton);
    }
    await delay(1_000);
  }
  throw new Error('The shared assistant access link did not finish applying within two minutes.');
}

function matchesAssistant(id: string, name: string, row: AssistantRow): boolean {
  return row.assistantId === id && (row.name === undefined || row.name === name);
}

async function qualifyDirectChat(
  options: BrowserPhase4Options,
  ownerPage: Page,
  memberMobile: Page,
  memberDesktop: Page,
  output: string,
): Promise<void> {
  const beforeModelCount = await modelRequestCount(options.modelStubPort);
  await memberMobile.setViewportSize({ width: 390, height: 844 });
  await startDirectDraft(memberMobile, options.origin);
  const recipientText = await memberMobile.locator('main').innerText();
  const mobileDraft = await screenshot(memberMobile, output, 'direct-chat-recipient-390');
  const mobileDraftEvidence = { colleague: ownerId };
  record(options.assertions, 'direct_chat.start_390',
    recipientText.includes(ownerId) && recipientText.includes('Draft — nothing is sent'),
    'The direct chat names only the chosen colleague before the first message.',
    mobileDraftEvidence, [mobileDraft]);

  await memberDesktop.setViewportSize({ width: 1280, height: 900 });
  await startDirectDraft(memberDesktop, options.origin);
  const desktopDraft = await screenshot(memberDesktop, output, 'direct-chat-recipient-1280');
  const desktopDraftText = await memberDesktop.locator('main').innerText();
  const desktopRecipientIsClear = desktopDraftText.includes(ownerId)
    && desktopDraftText.includes('Draft — nothing is sent');
  const desktopDraftEvidence = { colleague: ownerId };
  record(options.assertions, 'direct_chat.start_1280', desktopRecipientIsClear,
    'The direct chat recipient screen fits at 1280px.',
    desktopDraftEvidence, [desktopDraft]);

  const memberMessage = `Direct message ${randomUUID()}`;
  const conversationsBeforeSend = await directConversations(memberMobile);
  const previousConversationIds = new Set(conversationsBeforeSend.map(conversationId));
  await memberMobile.locator('#message').fill(memberMessage);
  await memberMobile.getByRole('button', { name: 'Send message' }).click();
  await memberMobile.getByText(memberMessage, { exact: true }).waitFor();
  const directList = await directConversations(memberMobile);
  const conversation = directList.find(matchesNewParticipants.bind(
    null, previousConversationIds, ownerId, memberId,
  ));
  assert(conversation, 'The member and colleague must have one direct conversation');

  await ownerPage.setViewportSize({ width: 390, height: 844 });
  await ownerPage.goto(`${options.origin}/workspace/direct?conversation=`
    + encodeURIComponent(conversation.conversationId));
  await ownerPage.getByText(memberMessage, { exact: true }).waitFor();
  const receivedScreens = await captureAtBothWidths(ownerPage, output, 'direct-chat-received');
  const receivedMessageIsVisible = await ownerPage.getByText(
    memberMessage, { exact: true },
  ).isVisible();
  const receivedEvidence = { conversationId: conversation.conversationId,
    author: memberId };
  record(options.assertions, 'direct_chat.receive', receivedMessageIsVisible,
    'The colleague receives the member message at 1280px and 390px.',
    receivedEvidence, receivedScreens);

  const ownerMessage = `Reply from the colleague ${randomUUID()}`;
  await ownerPage.locator('#message').fill(ownerMessage);
  await ownerPage.getByRole('button', { name: 'Send message' }).click();
  await ownerPage.getByText(ownerMessage, { exact: true }).waitFor();
  await memberDesktop.goto(`${options.origin}/workspace/direct?conversation=`
    + encodeURIComponent(conversation.conversationId));
  await memberDesktop.getByText(ownerMessage, { exact: true }).waitFor();
  const history = await conversationHistory(options.store, conversation.conversationId);
  const posted = history.filter(isMessagePosted);
  const orderIsCorrect = posted.length === 2
    && posted[0]?.data['authorId'] === memberId
    && posted[1]?.data['authorId'] === ownerId;
  const controls = await memberDesktop.locator('main').innerText();
  const hasAgentControls = /assistant|model|memory|stop reply/iu.test(controls);
  const afterModelCount = await modelRequestCount(options.modelStubPort);
  const requestDelta = afterModelCount - beforeModelCount;
  const agentEventCount = history.filter(isAgentEvent).length;
  const countsAreZero = requestDelta === 0 && agentEventCount === 0 && !hasAgentControls;
  const memberScreens = await captureAtBothWidths(memberDesktop, output, 'direct-chat-exchange');
  const exchangeEvidence = { memberMessages: posted.length, modelRequests: requestDelta,
    assistantRequests: agentEventCount, messageOrder: orderIsCorrect };
  const exchangeStatement = 'Both people exchange ordered messages. No assistant turn, '
    + 'model request or agent control appears.';
  record(options.assertions, 'direct_chat.exchange_and_no_agent',
    orderIsCorrect && countsAreZero,
    exchangeStatement, exchangeEvidence, memberScreens);
}

async function startDirectDraft(page: Page, origin: string): Promise<void> {
  await page.goto(`${origin}/workspace/direct`);
  await page.locator('.transcript[aria-busy="false"]').waitFor();

  // Return to a blank draft when a saved-data run opens the previous direct conversation.
  const draftButtonNames = ['New chat', 'Change'];
  for (const buttonName of draftButtonNames) {
    const draftButton = page.getByRole('button', { name: buttonName, exact: true });
    if (await draftButton.count()) {
      await draftButton.click();
      break;
    }
  }

  const colleagueSearch = page.locator('#colleague-search');
  await colleagueSearch.waitFor();
  const colleaguesResponse = await page.request.get(
    `${origin}/api/chat/colleagues?limit=50`);
  assert.equal(colleaguesResponse.status(), 200);
  const colleagues = await colleaguesResponse.json() as {
    rows: Array<{ memberId: string; displayName: string | null }>;
  };
  const colleague = colleagues.rows.find(matchesColleagueId);
  assert(colleague, `The direct chat list does not include ${ownerId}`);
  const displayName = colleague.displayName?.trim() || ownerId;
  await colleagueSearch.fill(displayName);
  const colleagueButton = page.locator('.colleague-option')
    .filter({ hasText: displayName }).first();
  await colleagueButton.waitFor();
  await colleagueButton.click();
  const finishSelection = page.getByRole('button', { name: 'Use selection', exact: true });
  await finishSelection.waitFor({ state: 'visible', timeout: 10_000 });
  await finishSelection.click();
  await page.locator('#message').waitFor({ state: 'visible', timeout: 10_000 });
}

function matchesColleagueId(colleague: { memberId: string }): boolean {
  return colleague.memberId === ownerId;
}

async function directConversations(page: Page): Promise<DirectConversation[]> {
  const response = await page.request.get(`${new URL(page.url()).origin}/api/conversations`);
  assert.equal(response.status(), 200);
  const body = await response.json() as { rows: DirectConversation[] };
  return body.rows;
}

function matchesParticipants(first: string, second: string, row: DirectConversation): boolean {
  return row.mode === 'direct' && row.participantIds.includes(first)
    && row.participantIds.includes(second);
}

function conversationId(conversation: DirectConversation): string {
  return conversation.conversationId;
}

function matchesNewParticipants(
  previousIds: Set<string>,
  first: string,
  second: string,
  row: DirectConversation,
): boolean {
  return !previousIds.has(row.conversationId) && matchesParticipants(first, second, row);
}

async function conversationHistory(
  store: EventStore,
  conversationId: string,
): Promise<Array<{ type: string; data: Record<string, unknown> }>> {
  const rows = [];
  for await (const stored of store.readStream(`conversation-${conversationId}`)) {
    rows.push({ type: stored.event.type, data: stored.event.data as Record<string, unknown> });
  }
  return rows;
}

function isMessagePosted(row: { type: string }): boolean {
  return row.type === 'message.posted';
}

function isAgentEvent(row: { type: string }): boolean {
  return row.type !== 'message.posted' && row.type !== 'conversation.created';
}

async function modelRequestCount(port: string): Promise<number> {
  const response = await fetch(`http://127.0.0.1:${port}/journey-counts`, {
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200, 'The local model stub must provide its request count');
  const body = await response.json() as { modelRequests: number };
  return body.modelRequests;
}

async function qualifyProvider(
  options: BrowserPhase4Options,
  page: Page,
  output: string,
): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${options.origin}/org/models`);
  await page.getByRole('heading', { name: 'Models & providers' }).waitFor();
  const providerResponse = await page.request.get(`${options.origin}/api/org/providers`);
  assert.equal(providerResponse.status(), 200);
  const providerBody = await providerResponse.json() as { rows: Array<{ name: string }> };
  if (providerBody.rows.length === 0) {
    await page.getByText('No providers saved', { exact: true }).waitFor();
  } else {
    for (const provider of providerBody.rows) {
      await page.getByText(provider.name, { exact: true }).waitFor();
    }
  }
  const mainText = await page.locator('oc-models main').innerText();
  const providerNamesAreVisible = providerBody.rows.length === 0
    ? mainText.includes('No providers saved')
    : providerBody.rows.every(providerNameIsVisible.bind(null, mainText));
  const listScreens = await captureAtBothWidths(page, output, 'provider-list');
  const providerListEvidence = { providerCount: providerBody.rows.length };
  record(options.assertions, 'providers.list', providerNamesAreVisible,
    'The provider page shows the names returned by the server.',
    providerListEvidence, listScreens);

  await page.getByRole('button', { name: 'Connect a provider' }).first().click();
  const providerName = `Journey stub ${randomUUID()}`;
  await page.locator('#provider-name').fill(providerName);
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await waitForProviderKeyField(page);
  await page.locator('#provider-key').fill(placeholderKey);
  const keyField = page.locator('#provider-key');
  assert.equal(await keyField.getAttribute('type'), 'password');
  await page.getByRole('button', { name: 'Save key', exact: true }).click();
  const provider = await waitForProviderKeySave(page, options.origin,
    providerName);
  const keyInputState = await page.evaluate(providerKeyInputState);
  const pageHasNoKey = await page.evaluate(checkPlaceholderAbsent, placeholderKey);
  const eventHasNoKey = await providerEventsHaveNoKey(options.store, provider.providerId);
  const logsHaveNoKey = await processLogsHaveNoKey(options.directory);
  const noKeyLeak = pageHasNoKey && eventHasNoKey && logsHaveNoKey;
  const statusFactsAreSeparate = !provider.reachable && !provider.modelAnswer;
  const keyScreens = await captureAtBothWidths(page, output, 'provider-key-saved');
  const keySaveEvidence = { providerId: provider.providerId, saved: true,
    reachable: false, modelAnswer: false, placeholderInPage: !pageHasNoKey,
    placeholderInEvents: !eventHasNoKey, placeholderInLogs: !logsHaveNoKey };
  record(options.assertions, 'providers.key_save', noKeyLeak && statusFactsAreSeparate,
    'The fake key is saved without a leak or a claim that it works.',
    keySaveEvidence, keyScreens);
  const keyInputEvidence = { inputState: keyInputState };
  options.assertions.push({ id: 'providers.key_input_cleared',
    status: keyInputState === 'clear' ? 'PASS' : 'NOT PROVEN',
    statement: 'The key input is empty after the save, when it remains on screen.',
    evidence: keyInputEvidence, screenshots: keyScreens });
}

function providerNameIsVisible(text: string, provider: { name: string }): boolean {
  return text.includes(provider.name);
}

async function waitForProviderKeyField(page: Page): Promise<void> {
  const deadline = Date.now() + 120_000;
  const keyField = page.locator('#provider-key');
  const statusButton = page.getByRole('dialog')
    .getByRole('button', { name: 'Check status', exact: true });
  const providerMain = page.locator('oc-models main');
  while (Date.now() < deadline) {
    if (await keyField.isVisible()) return;
    await clickStatusWhenEnabled(statusButton);
    await delay(1_000);
  }
  const message = await providerMain.innerText();
  throw new Error(`The provider name did not finish saving; screen said: ${message}`);
}

async function waitForProviderKeySave(
  page: Page,
  origin: string,
  providerName: string,
): Promise<{
  providerId: string;
  name: string;
  saved?: unknown;
  reachable?: unknown;
  modelAnswer?: unknown;
}> {
  const deadline = Date.now() + 120_000;
  const statusButton = page.getByRole('dialog')
    .getByRole('button', { name: 'Check status', exact: true });
  const providerMain = page.locator('oc-models main');
  while (Date.now() < deadline) {
    const response = await page.request.get(`${origin}/api/org/providers`);
    assert.equal(response.status(), 200, 'The provider list must remain available');
    const body = await response.json() as { rows: Array<{
      providerId: string;
      name: string;
      saved?: unknown;
      reachable?: unknown;
      modelAnswer?: unknown;
    }> };
    const provider = body.rows.find(matchesProviderName.bind(null, providerName));
    if (provider?.saved) return provider;
    await clickStatusWhenEnabled(statusButton);
    await delay(1_000);
  }
  const message = await providerMain.innerText();
  throw new Error(`The provider key did not finish saving; screen said: ${message}`);
}

async function qualifyOwnershipTransfer(
  options: BrowserPhase4Options,
  page: Page,
  output: string,
): Promise<void> {
  const initial = await ownershipView(page);
  if (initial.viewer.role !== 'owner') {
    const ownershipEvidence = { viewerRole: initial.viewer.role };
    options.assertions.push({ id: 'ownership.transfer', status: 'NOT PROVEN',
      statement: 'The signed-in test account is an admin, so it cannot appoint an owner.',
      evidence: ownershipEvidence, screenshots: [] });
    return;
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${options.origin}/org/people/owners`);
  await page.getByRole('heading', { name: 'Owners', exact: true }).waitFor();
  await page.locator('.owner-row code').getByText(ownerId, { exact: true }).waitFor();
  const actorScreens = await captureAtBothWidths(page, output, 'ownership-actor-ready');
  const actorIsOwner = initial.viewer.memberId === ownerId
    && initial.viewer.role === 'owner';
  const actorEvidence = { memberId: ownerId, role: 'owner' };
  record(options.assertions, 'ownership.actor_ready', actorIsOwner,
    'The signed-in browser account has the Owner role before opening the transfer screen.',
    actorEvidence, actorScreens);

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('button', { name: 'Appoint an owner', exact: true }).click();
  await page.locator('#successor-id').fill(memberId);
  await page.getByRole('button', { name: 'Review appointment', exact: true }).click();
  const review = page.getByRole('dialog');
  await review.getByText('You and this person will both be Owners.', { exact: true })
    .waitFor({ state: 'visible' });
  const reviewText = await review.innerText();
  const reviewScreens = await captureAtBothWidths(page, output, 'ownership-transfer-review');
  const reviewIsClear = reviewText.includes(memberId)
    && reviewText.includes('You and this person will both be Owners')
    && reviewText.includes("This doesn't remove you");
  const ownershipReviewEvidence = { successorId: memberId };
  record(options.assertions, 'ownership.review', reviewIsClear,
    'The owner reviews the named successor and sees that both people will remain owners.',
    ownershipReviewEvidence, reviewScreens);

  const requestPromise = page.waitForRequest(isOwnershipTransferRequest);
  const responsePromise = page.waitForResponse(isOwnershipTransferResponse);
  await review.getByRole('button', { name: 'Appoint this owner', exact: true }).click();
  const request = await requestPromise;
  const command = readOwnershipTransferCommand(request);
  const response = await responsePromise;
  const responseScreens = await captureAtBothWidths(page, output, 'ownership-transfer-response');
  const transferRequestEvidence = { successorId: command.successorId,
    expectedSequence: command.expectedSequence, responseStatus: response.status() };
  record(options.assertions, 'ownership.transfer_request', response.status() === 200,
    'The server accepts the reviewed transfer command.',
    transferRequestEvidence, responseScreens);
  assert.equal(response.status(), 200, 'The ownership transfer must be recorded');

  await waitForOwnershipTransfer(page, memberId);
  const resultScreens = await captureAtBothWidths(page, output, 'ownership-transfer-result');
  const resultText = await page.locator('main').innerText();
  const event = await ownershipTransferEvent(options.store, options.silo, memberId, ownerId);
  const bothPeopleAreOwners = resultText.includes(ownerId) && resultText.includes(memberId)
    && resultText.includes('You remain an owner');
  const transferMatchesReview = event.successorId === memberId && event.transferredBy === ownerId;
  const transferEvidence = { successorId: event.successorId,
    transferredBy: event.transferredBy, ownerIds: [ownerId, memberId] };
  record(options.assertions, 'ownership.transfer', bothPeopleAreOwners && transferMatchesReview,
    'The saved change makes the reviewed member an owner and leaves the first owner in place.',
    transferEvidence, resultScreens);
}

type OwnershipView = {
  owners: Array<{ memberId: string; role: string }>;
  viewer: { memberId: string; role: string };
};

async function ownershipView(page: Page): Promise<OwnershipView> {
  const response = await page.request.get(`${new URL(page.url()).origin}/api/ownership`);
  assert.equal(response.status(), 200, 'The signed-in organisation admin can read owners');
  const body = await response.json() as OwnershipView;
  return body;
}

async function waitForOwnershipRole(page: Page, memberIdToFind: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response = await page.request.get(`${new URL(page.url()).origin}/api/ownership`);
    if (response.ok()) {
      const body = await response.json() as OwnershipView;
      const isOwner = body.owners.some(matchesOwnerId.bind(null, memberIdToFind));
      if (isOwner && body.viewer.role === 'owner') return;
    }
    await delay(250);
  }
  throw new Error('The browser account did not receive the development Owner role.');
}

function matchesOwnerId(memberId: string, owner: OwnershipView['owners'][number]): boolean {
  return owner.memberId === memberId && owner.role === 'owner';
}

type OwnershipTransferCommand = {
  successorId: string;
  expectedSequence: number;
};

type OwnershipTransferData = {
  memberId: string;
  transferredBy: string;
};

function isOwnershipTransferRequest(request: BrowserRequest): boolean {
  const url = new URL(request.url());
  if (request.method() !== 'POST' || url.pathname !== '/api/ownership') return false;
  const body = request.postDataJSON() as Record<string, unknown>;
  return body['action'] === 'transfer';
}

function isOwnershipTransferResponse(response: BrowserResponse): boolean {
  const url = new URL(response.url());
  return response.request().method() === 'POST' && url.pathname === '/api/ownership';
}

function readOwnershipTransferCommand(request: BrowserRequest): OwnershipTransferCommand {
  const body = request.postDataJSON() as Record<string, unknown>;
  assert(typeof body['successorId'] === 'string');
  assert(typeof body['expectedSequence'] === 'number');
  return { successorId: body['successorId'], expectedSequence: body['expectedSequence'] };
}

async function waitForOwnershipTransfer(page: Page, successorId: string): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const ownershipText = await page.locator('main').innerText();
    const ownerListText = await page.locator('.owner-list').innerText();
    if (ownerListText.includes(ownerId) && ownerListText.includes(successorId)
      && ownershipText.includes('You remain an owner')) return;
    const statusButton = page.getByRole('button', { name: /Check status|Checking/ });
    await clickStatusWhenEnabled(statusButton);
    await delay(500);
  }
  throw new Error('The reviewed ownership transfer did not finish applying within two minutes.');
}

async function clickStatusWhenEnabled(button: Locator): Promise<boolean> {
  if (!(await button.count())) return false;
  if (!(await button.isEnabled())) return false;
  await button.click();
  return true;
}

async function ownershipTransferEvent(
  store: EventStore,
  silo: string,
  successorId: string,
  transferredBy: string,
): Promise<{ successorId: string; transferredBy: string }> {
  for await (const stored of store.readStream(ownershipSubject(silo))) {
    if (stored.event.silo !== silo || stored.event.type !== 'ownership.transferred') continue;
    const data = stored.event.data as OwnershipTransferData;
    if (data.memberId !== successorId || data.transferredBy !== transferredBy) continue;
    return { successorId: data.memberId, transferredBy: data.transferredBy };
  }
  throw new Error(`No ownership transfer event names ${successorId} as the successor`);
}

async function providerEventsHaveNoKey(store: EventStore, providerId: string): Promise<boolean> {
  for await (const stored of store.readStream(`provider-${providerId}`)) {
    if (JSON.stringify(stored.event).includes(placeholderKey)) return false;
  }
  return true;
}

async function processLogsHaveNoKey(directory: string): Promise<boolean> {
  const names = ['server', 'web', 'members', 'mcp-catalogue', 'dispatcher'];
  for (const name of names) {
    const log = await readFile(`${directory}/${name}.log`, 'utf8');
    if (log.includes(placeholderKey)) return false;
  }
  return true;
}

function matchesProviderName(name: string, provider: { name: string }): boolean {
  return provider.name === name;
}

function checkPlaceholderAbsent(key: string): boolean {
  const pageText = document.documentElement.innerText + document.documentElement.outerHTML;
  function readStorageItem(name: string, storage: Storage): string {
    return `${name}=${storage.getItem(name) ?? ''}`;
  }
  function readLocalItem(name: string) {
    return readStorageItem(name, localStorage);
  }
  function readSessionItem(name: string) {
    return readStorageItem(name, sessionStorage);
  }
  const localItems = Object.keys(localStorage).map(readLocalItem);
  const sessionItems = Object.keys(sessionStorage).map(readSessionItem);
  const savedText = JSON.stringify({
    local: localItems,
    session: sessionItems,
  });
  return !pageText.includes(key) && !savedText.includes(key);
}

function providerKeyInputState(): 'clear' | 'filled' | 'missing' {
  const keyInput = document.querySelector<HTMLInputElement>('#provider-key');
  if (!keyInput) return 'missing';
  if (keyInput.value === '') return 'clear';
  return 'filled';
}

async function captureAtBothWidths(
  page: Page,
  output: string,
  name: string,
): Promise<string[]> {
  const screenshots: string[] = [];
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    screenshots.push(await screenshot(page, output, `${name}-${width}`));
  }
  return screenshots;
}

async function screenshot(page: Page, output: string, name: string): Promise<string> {
  const pageWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  const viewportWidth = page.viewportSize()?.width;
  assert.equal(pageWidth, viewportWidth, `${name} must not scroll sideways`);
  const destination = resolve(output, `${name}.png`);
  await page.screenshot({ path: destination, fullPage: false,
    animations: 'disabled', timeout: 90_000 });
  return destination;
}

function record(
  assertions: Phase4Assertion[],
  id: string,
  passed: boolean,
  statement: string,
  evidence: Phase4Assertion['evidence'],
  screenshots: string[],
): void {
  assertions.push({ id, status: passed ? 'PASS' : 'FAIL', statement, evidence, screenshots });
  assert(passed, `Phase 4 assertion failed: ${id}`);
}

function addNonRunRows(assertions: Phase4Assertion[], attempt: string): void {
  assertions.push({ id: 'providers.paid_model_answer', status: 'PAID / NOT RUN',
    statement: 'The real provider answer check needs a paid call and was not run.',
    evidence: { paidCallMade: false, attempt }, screenshots: [] });
  assertions.push({ id: 'shared_assistant.member_disk_isolation', status: 'NOT PROVEN',
    statement: 'Separate member disks and browser profiles for assistant sessions are not built.',
    evidence: { assistantBrowserProfiles: false, assistantComputerDisks: 1 }, screenshots: [] });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
