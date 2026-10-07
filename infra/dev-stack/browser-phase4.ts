/// <reference lib="dom" />
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Locator, Page, Request as BrowserRequest, Response as BrowserResponse }
  from 'playwright';
import type { EventStore } from '@opencrane/event-store';
import { grantStream } from '@opencrane/authz';
import { models, ownershipSubject } from '@opencrane/models';
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
  ownershipMerged: boolean;
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

const screenshotRoot = resolve('docs/process/p4-journey');
const ownerId = 'zitadel-owner';
const memberId = 'zitadel-member';
const placeholderKey = 'journey-placeholder-not-a-provider-key';

export async function browserPhase4(options: BrowserPhase4Options): Promise<void> {
  const ownerPage = options.ownerPage;
  const memberMobile = findPage(options.memberPages, 390);
  const memberDesktop = findPage(options.memberPages, 1280);
  const attemptDirectory = resolve(screenshotRoot, `run-${options.attempt}`);
  await mkdir(attemptDirectory, { recursive: true });
  addNonRunRows(options.assertions, options.attempt, options.ownershipMerged);

  const group = await qualifyGroups(options, ownerPage, attemptDirectory);
  await qualifySharedAssistant(options, ownerPage, memberMobile, memberDesktop,
    attemptDirectory, group);
  await qualifyGroupRemoval(options, ownerPage, attemptDirectory, group);
  await qualifyDirectChat(options, ownerPage, memberMobile, memberDesktop,
    attemptDirectory);
  await qualifyProvider(options, ownerPage, attemptDirectory);
  if (options.ownershipMerged) {
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
  const groupId = `journey-${crypto.randomUUID().replaceAll('-', '')}`;
  const groupName = `Journey group ${options.attempt}`;
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${options.origin}/org/people`);
  await page.getByRole('tab', { name: /Groups/ }).click();
  await page.locator('#group-search').waitFor();
  const listScreens = await captureAtBothWidths(page, output, 'groups-list');
  record(options.assertions, 'groups.list', true,
    'The Owner can open the groups list at 1280px and 390px.', {}, listScreens);

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
  record(options.assertions, 'groups.create', true,
    'The Owner creates a local group and can open its detail page.',
    { groupId: groupIdFromUrl, groupName }, createdScreens);

  await addMember(options, page, groupIdFromUrl);
  const modelId = currentModelId();
  await options.append('grant.given', grantStream('model', modelId), {
    resourceType: 'model', resourceId: modelId, granteeKind: 'team',
    granteeId: groupIdFromUrl, grantedBy: ownerId,
  });
  await waitForGroup(page, groupIdFromUrl, hasGroupGrant.bind(null, modelId));

  await page.goto(`${options.origin}/org/people`);
  await page.getByRole('tab', { name: /Groups/ }).click();
  await page.locator('#group-search').fill(groupName);
  const matchingGroupRow = page.locator('.group-row').filter({ hasText: groupName });
  await matchingGroupRow.waitFor();
  const searchScreens = await captureAtBothWidths(page, output, 'groups-search');
  record(options.assertions, 'groups.search', true,
    'Searching by the new group name finds its row at 1280px and 390px.',
    { groupName }, searchScreens);

  await page.goto(`${options.origin}${detailUrl}`);
  await page.getByRole('heading', { name: groupName, exact: true }).waitFor();
  const detailScreens = await captureAtBothWidths(page, output, 'groups-detail');
  const detailText = await page.locator('main').innerText();
  record(options.assertions, 'groups.detail',
    detailText.includes(memberId) && detailText.includes(modelId),
    'Group detail shows the member and model grant.',
    { memberId, modelId }, detailScreens);

  return { groupId: groupIdFromUrl, groupName, modelId };
}

async function qualifyGroupRemoval(
  options: BrowserPhase4Options,
  page: Page,
  output: string,
  group: { groupId: string; groupName: string; modelId: string },
): Promise<void> {
  const groupId = group.groupId;
  const groupName = group.groupName;
  await page.goto(`${options.origin}/org/people/groups/${groupId}`);
  const reviewScreens = await openRemovalReviewAtBothWidths(page, output, groupName);
  const review = page.getByRole('dialog');
  const reviewText = await review.innerText();
  const reviewCopyIsClear = reviewText.includes('private conversations and memory')
    && reviewText.includes('within two seconds');
  record(options.assertions, 'groups.removal_review', reviewCopyIsClear,
    'Removal review explains what access ends and when.', {}, reviewScreens);
  await review.getByRole('button', { name: `Remove ${memberId} from ${groupName}` }).click();
  await page.getByText(`Removed ${memberId} from ${groupName}`).waitFor();
  await waitForGroup(page, groupId, memberIsAbsent);
  const removedScreens = await captureAtBothWidths(page, output, 'groups-removed');
  record(options.assertions, 'groups.remove_member', true,
    'The reviewed removal completes and the member is gone from the current group record.',
    { removedMemberId: memberId }, removedScreens);

}

async function addMember(
  options: BrowserPhase4Options,
  page: Page,
  groupId: string,
): Promise<void> {
  const response = await page.request.post(`${options.origin}/api/groups/${groupId}`, {
    headers: { origin: options.origin },
    data: { action: 'add', commandId: `journey-add-${crypto.randomUUID()}`, memberId },
  });
  assert.equal(response.status(), 200, 'The existing group command must add the seeded member');
  await waitForGroup(page, groupId, memberIsPresent);
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
  const activeModel = models.find(isActiveModel);
  assert(activeModel, 'The model registry must contain an active model');
  return activeModel.id;
}

function isActiveModel(model: (typeof models)[number]): boolean {
  return !model.retired;
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
): Promise<void> {
  await ownerPage.setViewportSize({ width: 1280, height: 900 });
  await ownerPage.goto(`${options.origin}/org/people/groups/${group.groupId}/assistants/new`);
  await ownerPage.getByRole('heading', { name: 'Create a shared assistant' }).waitFor();
  const assistantName = `Shared journey ${options.attempt}`;
  await ownerPage.locator('#assistant-name').fill(assistantName);
  const modelChoice = ownerPage.getByRole('checkbox', {
    name: `Model ${group.modelId}`,
    exact: true,
  });
  await modelChoice.check();
  const setupScreens = await captureAtBothWidths(ownerPage, output, 'shared-assistant-create');
  const setupText = await ownerPage.locator('main').innerText();
  record(options.assertions, 'shared_assistant.admin_create',
    setupText.includes(group.groupName) && setupText.includes('Paying group')
      && setupText.includes('Memory is not included'),
    'The admin can choose this group, its payer and its model grant.',
    { groupName: group.groupName, payerGroup: group.groupId, modelId: group.modelId }, setupScreens);

  await ownerPage.getByRole('button', { name: 'Review assistant' }).click();
  const review = ownerPage.getByRole('dialog');
  const reviewScreens = await captureAtBothWidths(ownerPage, output, 'shared-assistant-review');
  const reviewText = await review.innerText();
  record(options.assertions, 'shared_assistant.review',
    reviewText.includes('Fixed payer') && reviewText.includes(group.groupName),
    'The review names the fixed paying group before the assistant is created.',
    { payerGroup: group.groupId }, reviewScreens);
  const createRequestPromise = ownerPage.waitForRequest(isAssistantCreateRequest);
  const createResponsePromise = ownerPage.waitForResponse(isAssistantCreateResponse);
  await review.getByRole('button', { name: 'Create assistant', exact: true }).click();
  const createRequest = await createRequestPromise;
  const createCommand = readAssistantCreateCommand(createRequest);
  const createResponse = await createResponsePromise;
  const responseScreens = await captureAtBothWidths(ownerPage, output,
    'shared-assistant-create-response');
  record(options.assertions, 'shared_assistant.create_request', createResponse.status() === 200,
    'The server accepts the assistant create request from the review.',
    { responseStatus: createResponse.status(), assistantId: createCommand.assistantId,
      commandKeys: createCommand.keys, hasStage: createCommand.keys.includes('stage'),
      groupId: createCommand.groupId, payingGroupId: createCommand.payingGroupId,
      name: createCommand.name, grantIds: createCommand.grantIds },
    responseScreens);
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
  record(options.assertions, 'shared_assistant.created', createdMatchesReview,
    'The saved assistant event names the owner group, payer, model and display name.',
    { assistantId: createCommand.assistantId, payerGroup: createdData.payingGroupId,
      ownerGroup: createdData.ownerId, creationMatchesReview: createdMatchesReview },
    createdScreens);
  record(options.assertions, 'shared_assistant.computer_ready_for_selection', true,
    'The assistant appears in the member selection list after its computer record is ready.',
    { assistantId: created.assistantId, status: created.status ?? 'unknown' }, createdScreens);

  await memberMobile.goto(`${options.origin}/workspace/shared`);
  await memberMobile.getByRole('button', {
    name: new RegExp(`Choose ${escapeRegExp(assistantName)}`),
  }).waitFor();
  const eligibleScreens = await captureAtBothWidths(memberMobile, output, 'shared-assistant-choice');
  const pickerText = await memberMobile.locator('main').innerText();
  record(options.assertions, 'shared_assistant.member_choice',
    pickerText.includes('Private to you') && pickerText.includes('transcript is private'),
    'The member can choose the shared assistant for a private session.',
    { assistantId: created.assistantId, assistantName }, eligibleScreens);

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
  const sessionScreens = await captureAtBothWidths(memberMobile, output,
    'shared-assistant-session-response');
  record(options.assertions, 'shared_assistant.session_recorded', sessionStatus === 200,
    'The server records the member’s private session with this shared assistant.',
    { assistantId: sessionCommand.assistantId, payingGroupId: sessionCommand.payingGroupId,
      conversationId: sessionCommand.conversationId, responseStatus: sessionStatus },
    sessionScreens);
  assert.equal(sessionStatus, 200, 'The server must record the private session');
  await waitForPrivateSessionToApply(memberMobile);
  const privateUrl = memberMobile.url();
  const privateScreens = await captureAtBothWidths(memberMobile, output, 'shared-assistant-private-chat');
  const privateText = await memberMobile.locator('main').innerText();
  const savedSession = await privateSessionEvent(options.store, options.silo,
    sessionCommand.conversationId);
  const savedSessionMatchesChoice = savedSession.createdBy === memberId
    && savedSession.assistantId === created.assistantId
    && savedSession.payingGroupId === group.groupId;
  record(options.assertions, 'shared_assistant.private_chat',
    privateText.includes('Private session') && savedSessionMatchesChoice,
    'The selected assistant opens a private chat with the fixed paying group recorded.',
    { assistantId: savedSession.assistantId, payingGroupId: savedSession.payingGroupId,
      createdBy: savedSession.createdBy, privateUrl }, privateScreens);

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
  await memberMobile.goto(`${options.origin}/workspace/direct`);
  await memberMobile.locator('#colleague-search').fill(ownerId);
  await memberMobile.getByRole('button', { name: ownerId }).waitFor();
  await memberMobile.getByRole('button', { name: ownerId }).click();
  const recipientText = await memberMobile.locator('main').innerText();
  const mobileDraft = await screenshot(memberMobile, output, 'direct-chat-recipient-390');
  record(options.assertions, 'direct_chat.start_390',
    recipientText.includes(ownerId) && recipientText.includes('Draft — nothing is sent'),
    'The direct chat names only the chosen colleague before the first message.',
    { colleague: ownerId }, [mobileDraft]);

  await memberDesktop.setViewportSize({ width: 1280, height: 900 });
  await memberDesktop.goto(`${options.origin}/workspace/direct`);
  await memberDesktop.locator('#colleague-search').fill(ownerId);
  await memberDesktop.getByRole('button', { name: ownerId }).click();
  const desktopDraft = await screenshot(memberDesktop, output, 'direct-chat-recipient-1280');
  const desktopDraftText = await memberDesktop.locator('main').innerText();
  const desktopRecipientIsClear = desktopDraftText.includes(ownerId)
    && desktopDraftText.includes('Draft — nothing is sent');
  record(options.assertions, 'direct_chat.start_1280', desktopRecipientIsClear,
    'The direct chat recipient screen fits at 1280px.', { colleague: ownerId }, [desktopDraft]);

  await memberMobile.locator('#message').fill('Direct message from the member.');
  await memberMobile.getByRole('button', { name: 'Send message' }).click();
  await memberMobile.getByText('Direct message from the member.', { exact: true }).waitFor();
  const directList = await directConversations(memberMobile);
  const conversation = directList.find(matchesParticipants.bind(null, ownerId, memberId));
  assert(conversation, 'The member and colleague must have one direct conversation');

  await ownerPage.setViewportSize({ width: 390, height: 844 });
  await ownerPage.goto(`${options.origin}/workspace/direct?conversation=`
    + encodeURIComponent(conversation.conversationId));
  await ownerPage.getByText('Direct message from the member.', { exact: true }).waitFor();
  const receivedScreens = await captureAtBothWidths(ownerPage, output, 'direct-chat-received');
  record(options.assertions, 'direct_chat.receive', true,
    'The colleague receives the member message at 1280px and 390px.',
    { conversationId: conversation.conversationId, author: memberId }, receivedScreens);

  await ownerPage.locator('#message').fill('Reply from the colleague.');
  await ownerPage.getByRole('button', { name: 'Send message' }).click();
  await ownerPage.getByText('Reply from the colleague.', { exact: true }).waitFor();
  await memberDesktop.goto(`${options.origin}/workspace/direct?conversation=`
    + encodeURIComponent(conversation.conversationId));
  await memberDesktop.getByText('Reply from the colleague.', { exact: true }).waitFor();
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
  record(options.assertions, 'direct_chat.exchange_and_no_agent',
    orderIsCorrect && countsAreZero,
    'Both people exchange ordered messages; no assistant turn, model request, or agent control appears.',
    { memberMessages: posted.length, modelRequests: requestDelta, assistantRequests: agentEventCount,
      messageOrder: orderIsCorrect }, memberScreens);
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
  const emptyState = page.getByText('No providers saved', { exact: true });
  await emptyState.waitFor({ state: 'visible' });
  const empty = await emptyState.isVisible();
  const listScreens = await captureAtBothWidths(page, output, 'provider-list');
  record(options.assertions, 'providers.list', empty,
    'The fresh stack shows an empty provider list at 1280px and 390px.', {}, listScreens);

  await page.getByRole('button', { name: 'Connect a provider' }).first().click();
  await page.locator('#provider-name').fill(`Journey stub ${options.attempt}`);
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await waitForProviderKeyField(page);
  await page.locator('#provider-key').fill(placeholderKey);
  const keyField = page.locator('#provider-key');
  assert.equal(await keyField.getAttribute('type'), 'password');
  await page.getByRole('button', { name: 'Save key', exact: true }).click();
  const provider = await waitForProviderKeySave(page, options.origin,
    `Journey stub ${options.attempt}`);
  const keyInputIsClear = await page.evaluate(providerKeyInputIsClear);
  const pageHasNoKey = await page.evaluate(checkPlaceholderAbsent, placeholderKey);
  const eventHasNoKey = await providerEventsHaveNoKey(options.store, provider.providerId);
  const logsHaveNoKey = await processLogsHaveNoKey(options.directory);
  const noKeyLeak = pageHasNoKey && eventHasNoKey && logsHaveNoKey;
  const statusFactsAreSeparate = !provider.reachable && !provider.modelAnswer;
  const keyScreens = await captureAtBothWidths(page, output, 'provider-key-saved');
  record(options.assertions, 'providers.key_save', noKeyLeak && statusFactsAreSeparate
      && keyInputIsClear,
    'The fake key is saved and cleared; the page does not claim reachability or a model answer.',
    { providerId: provider.providerId, saved: true, reachable: false, modelAnswer: false,
      inputIsClear: keyInputIsClear, placeholderInPage: !pageHasNoKey,
      placeholderInEvents: !eventHasNoKey,
      placeholderInLogs: !logsHaveNoKey }, keyScreens);
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
  await prepareOwnerBrowserAccount(options, page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${options.origin}/org/people/owners`);
  await page.getByRole('heading', { name: 'Owners', exact: true }).waitFor();
  await page.locator('.owner-row code').getByText(ownerId, { exact: true }).waitFor();
  const actorScreens = await captureAtBothWidths(page, output, 'ownership-actor-ready');
  record(options.assertions, 'ownership.actor_ready', true,
    'The signed-in browser account has the Owner role before opening the transfer screen.',
    { memberId: ownerId, role: 'owner' }, actorScreens);

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
  record(options.assertions, 'ownership.review', reviewIsClear,
    'The owner reviews the named successor and sees that both people will remain owners.',
    { successorId: memberId }, reviewScreens);

  const requestPromise = page.waitForRequest(isOwnershipTransferRequest);
  const responsePromise = page.waitForResponse(isOwnershipTransferResponse);
  await review.getByRole('button', { name: 'Appoint this owner', exact: true }).click();
  const request = await requestPromise;
  const command = readOwnershipTransferCommand(request);
  const response = await responsePromise;
  const responseScreens = await captureAtBothWidths(page, output, 'ownership-transfer-response');
  record(options.assertions, 'ownership.transfer_request', response.status() === 200,
    'The server accepts the reviewed transfer command.',
    { successorId: command.successorId, expectedSequence: command.expectedSequence,
      responseStatus: response.status() }, responseScreens);
  assert.equal(response.status(), 200, 'The ownership transfer must be recorded');

  await waitForOwnershipTransfer(page, memberId);
  const resultScreens = await captureAtBothWidths(page, output, 'ownership-transfer-result');
  const resultText = await page.locator('main').innerText();
  const event = await ownershipTransferEvent(options.store, options.silo, memberId, ownerId);
  const bothPeopleAreOwners = resultText.includes(ownerId) && resultText.includes(memberId)
    && resultText.includes('You remain an owner');
  const transferMatchesReview = event.successorId === memberId && event.transferredBy === ownerId;
  record(options.assertions, 'ownership.transfer', bothPeopleAreOwners && transferMatchesReview,
    'The saved change makes the reviewed member an owner and leaves the first owner in place.',
    { successorId: event.successorId, transferredBy: event.transferredBy,
      ownerIds: [ownerId, memberId] }, resultScreens);
}

type OwnershipView = {
  owners: Array<{ memberId: string; role: string }>;
  viewer: { memberId: string; role: string };
};

async function prepareOwnerBrowserAccount(
  options: BrowserPhase4Options,
  page: Page,
): Promise<void> {
  const initial = await ownershipView(page);
  assert(initial.viewer.memberId === ownerId,
    'The signed-in owner page must belong to the seeded organisation admin');
  assert(initial.owners.some(matchesOwnerId.bind(null, 'jente-rosseel')),
    'The real development owner must be present before preparing the browser account');
  if (initial.owners.some(matchesOwnerId.bind(null, ownerId))) return;

  await options.append('ownership.transferred', ownershipSubject(options.silo), {
    memberId: ownerId,
    transferredBy: 'jente-rosseel',
  }, 'dev-stack-ownership-fixture');
  await waitForOwnershipRole(page, ownerId);
}

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

function providerKeyInputIsClear(): boolean {
  const keyInput = document.querySelector<HTMLInputElement>('#provider-key');
  return !keyInput || keyInput.value === '';
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
  return destination.replace(`${resolve('.')}/`, '');
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

function addNonRunRows(
  assertions: Phase4Assertion[],
  attempt: string,
  ownershipMerged: boolean,
): void {
  if (!ownershipMerged) {
    assertions.push({ id: 'ownership.transfer', status: 'NOT PROVEN',
      statement: 'Ownership transfer was not run because its change was not merged.',
      evidence: { merged: false }, screenshots: [] });
  }
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
