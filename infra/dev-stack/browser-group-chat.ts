/// <reference lib="dom" />
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Locator, Page, Response as BrowserResponse } from 'playwright';
import type { EventStore } from '@opencrane/event-store';
import { readEvents } from '@opencrane/projections';
import type { Phase4Assertion } from './browser-phase4.ts';
import { checkGroupRemoval } from './browser-group-removal.ts';

type GroupChatOptions = {
  ownerPage: Page;
  memberPages: Page[];
  otherPage: Page;
  thirdPage: Page;
  origin: string;
  directory: string;
  attempt: string;
  store: EventStore;
  assertions: Phase4Assertion[];
  restartConversations: () => Promise<void>;
};

type ConversationRow = {
  conversationId: string;
  mode: string;
  participantIds: string[];
};

type ActivityCounts = {
  aiEvents: string[];
  computerEvents: string[];
  budgetEvents: string[];
};

const assertionNames = [
  ['group_chat.create_and_lock_mode', 'The To line creates a group before sending, and its mode stays fixed.'],
  ['group_chat.messages_and_no_activity', 'Every participant sees each message, with no AI, computer or budget activity.'],
  ['group_chat.add_join_position', 'A later participant sees messages only from their join position.'],
  ['group_chat.remove_clears_access', 'Removal clears the participant transcript and live updates within two seconds.'],
  ['group_chat.leave_clears_access', 'Leaving clears that transcript and the other participants see the change.'],
  ['group_chat.people_picker_states', 'The people picker handles long names, no matches and denied selection.'],
  ['group_chat.unsupported_combination', 'An unsupported recipient combination is refused without a saved draft.'],
  ['group_chat.replay_preserves_group', 'Replay keeps the group participants and mode unchanged.'],
] as const;

export async function browserGroupChat(options: GroupChatOptions): Promise<void> {
  const output = resolve(options.directory, 'p4-journey', options.attempt, 'group-chat');
  await mkdir(output, { recursive: true });
  initialiseAssertions(options.assertions);
  const owner = options.ownerPage;
  const colleague = options.memberPages[0];
  const secondColleague = options.otherPage;
  const laterColleague = options.thirdPage;
  assert(colleague, 'A signed-in colleague page is required');

  let conversationId = '';
  let modeBeforeSend = '';
  let modeAfterSend = '';
  let initialActivity: ActivityCounts | undefined;
  let firstSendActivity: ActivityCounts | undefined;
  let afterSendActivity: ActivityCounts | undefined;

  try {
    await openDraft(owner, options.origin);
    const colleagues = await readColleagues(owner, options.origin);
    const laterPerson = colleagueById(colleagues, 'p4-5-later-participant');
    const firstPerson = colleagueById(colleagues, 'zitadel-member');
    const secondPerson = colleagueById(colleagues, 'audit-other-member');
    assert(laterPerson && firstPerson && secondPerson,
      'The picker needs two seeded colleagues and the later participant');
    assert(laterPerson.displayName && firstPerson.displayName && secondPerson.displayName,
      'The seeded group colleagues need display names');
    const pickerEvidence = await inspectPicker(owner, output, laterPerson.displayName);
    await removeSelectedPerson(owner, laterPerson.displayName);
    await selectColleague(owner, firstPerson.displayName);
    await selectColleague(owner, secondPerson.displayName);

    const unsupported = await refuseUnsupportedCombination(owner, output);
    setAssertion(options.assertions, 'group_chat.unsupported_combination', unsupported.passed,
      unsupported.evidence, unsupported.screenshots);

    const modeNote = await owner.locator('.mode-note').innerText();
    modeBeforeSend = modeNote.includes('Group conversation') ? 'group' : 'unknown';
    const beforeSendScreens = await captureBoth(owner, output, 'group-mode-before-send');
    const beforeList = await readConversations(owner, options.origin);
    await waitForComputersToSettle(options.store);
    initialActivity = await countActivity(options.store);
    const firstDisplay = await sendMessage(owner, 'Group message before the new person joins');
    firstSendActivity = await waitForStableActivity(options.store);
    conversationId = await waitForNewConversation(owner, options.origin, beforeList);
    modeAfterSend = (await readConversation(owner, options.origin, conversationId)).mode;
    await waitForMessage(owner, 'Group message before the new person joins');
    const createdScreens = await captureBoth(owner, output, 'group-created');
    const modePassed = modeBeforeSend === 'group' && modeAfterSend === 'group';
    setAssertion(options.assertions, 'group_chat.create_and_lock_mode', modePassed,
      { modeBeforeSend, modeAfterSend, conversationId,
        firstDisplayMs: firstDisplay.displayMs, firstDisplayedAtMs: firstDisplay.displayedAtMs,
        firstCommandId: firstDisplay.commandId },
      [...beforeSendScreens, ...createdScreens]);

    await openConversation(colleague, options.origin, conversationId);
    await openConversation(secondColleague, options.origin, conversationId);
    const deniedEvidence = await deniedParticipantSelection(colleague, options.origin,
      conversationId, output);
    setAssertion(options.assertions, 'group_chat.people_picker_states',
      pickerEvidence.passed && deniedEvidence.denied,
      { ...pickerEvidence.evidence, deniedSelectionStatus: deniedEvidence.status,
        addControlHidden: deniedEvidence.addControlHidden },
      [...pickerEvidence.screenshots, ...deniedEvidence.screenshots]);

    await addParticipant(owner, options.origin, conversationId, laterPerson.displayName);
    await openConversation(laterColleague, options.origin, conversationId);
    const laterParticipantCanReadOldMessage = await hasMessage(
      laterColleague, 'Group message before the new person joins');
    const joinScreens = await captureBoth(laterColleague, output, 'group-join-position');
    setAssertion(options.assertions, 'group_chat.add_join_position',
      !laterParticipantCanReadOldMessage,
      { oldMessageVisibleAfterJoin: laterParticipantCanReadOldMessage }, joinScreens);

    try {
      const laterMessage = 'Group message after everyone joined';
      const beforeLaterSend = await waitForStableActivity(options.store);
      const laterDisplay = await sendMessage(owner, laterMessage);
      await openConversation(colleague, options.origin, conversationId);
      await openConversation(secondColleague, options.origin, conversationId);
      await openConversation(laterColleague, options.origin, conversationId);
      const firstMessageSeen = await hasMessage(colleague,
        'Group message before the new person joins')
        && await hasMessage(secondColleague, 'Group message before the new person joins');
      await waitForMessage(colleague, laterMessage);
      await waitForMessage(secondColleague, laterMessage);
      await waitForMessage(laterColleague, laterMessage);
      afterSendActivity = await waitForStableActivity(options.store);
      const activityDuringSends = activityBetweenSends(initialActivity, firstSendActivity,
        beforeLaterSend, afterSendActivity);
      const activityIsQuiet = activityDuringSends.aiEvents.length === 0
        && activityDuringSends.computerEvents.length === 0
        && activityDuringSends.budgetEvents.length === 0;
      const messageScreens = await captureBoth(secondColleague, output, 'group-messages');
      setAssertion(options.assertions, 'group_chat.messages_and_no_activity',
        firstMessageSeen && activityIsQuiet,
        { firstMessageSeen, laterDisplayMs: laterDisplay.displayMs,
          laterDisplayedAtMs: laterDisplay.displayedAtMs, laterCommandId: laterDisplay.commandId,
          aiEventsDuringSends: activityDuringSends.aiEvents,
          computerEventsDuringSends: activityDuringSends.computerEvents,
          budgetEventsDuringSends: activityDuringSends.budgetEvents },
        messageScreens);
    } catch (error) {
      await recordFailedStep(options.assertions, 'group_chat.messages_and_no_activity',
        error, secondColleague, output, 'group-messages');
    }

    try {
      await openConversation(owner, options.origin, conversationId);
      await owner.getByRole('button', { name: 'Participants', exact: true }).click();
      const removalOptions = {
        owner, removed: colleague, origin: options.origin, conversationId,
        name: firstPerson.displayName,
        oldMessage: 'Group message before the new person joins', store: options.store,
      };
      const removeResult = await checkGroupRemoval(removalOptions);
      const removeScreens = await captureBoth(colleague, output, 'group-removed-cleared');
      setAssertion(options.assertions, 'group_chat.remove_clears_access', removeResult.cleared,
        removeResult.hops, removeScreens);
    } catch (error) {
      await recordFailedStep(options.assertions, 'group_chat.remove_clears_access',
        error, colleague, output, 'group-removed-cleared');
    }

    try {
      await openConversation(owner, options.origin, conversationId);
      await owner.getByRole('button', { name: 'Participants', exact: true }).click();
      const ownerParticipants = owner.locator('.participant-list').first();
      const leaveStartedAt = await leaveConversation(laterColleague, options.origin,
        conversationId);
      const leaveResult = await observeClearedAccess(laterColleague,
        'Group message before the new person joins', leaveStartedAt);
      await waitForParticipantAbsent(ownerParticipants,
        'Maximiliana Alexandra de la Cruz-Wellington');
      const leaveScreens = await captureBoth(laterColleague, output, 'group-left-cleared');
      setAssertion(options.assertions, 'group_chat.leave_clears_access', leaveResult.cleared,
        { clearTimeMs: leaveResult.elapsedMs, transcriptEmpty: leaveResult.transcriptEmpty,
          othersSawLeave: true }, leaveScreens);
    } catch (error) {
      await recordFailedStep(options.assertions, 'group_chat.leave_clears_access',
        error, laterColleague, output, 'group-left-cleared');
    }

    try {
      const beforeReplay = await readConversation(owner, options.origin, conversationId);
      const participantIdsBeforeReplay = [...beforeReplay.participantIds].sort();
      await options.restartConversations();
      const afterReplay = await readConversation(owner, options.origin, conversationId);
      const replayScreens = await captureBoth(owner, output, 'group-after-replay');
      const replayPassed = afterReplay.mode === 'group'
        && sameStrings(participantIdsBeforeReplay, [...afterReplay.participantIds].sort());
      setAssertion(options.assertions, 'group_chat.replay_preserves_group', replayPassed,
        { modeBeforeReplay: beforeReplay.mode, modeAfterReplay: afterReplay.mode,
          participantIdsBeforeReplay, participantIdsAfterReplay: afterReplay.participantIds },
        replayScreens);
    } catch (error) {
      await recordFailedStep(options.assertions, 'group_chat.replay_preserves_group',
        error, owner, output, 'group-after-replay');
    }
  } catch (error) {
    const reason = errorMessage(error);
    markUnprovenAssertions(options.assertions, reason);
  }
  for (const assertion of options.assertions) {
    if (assertion.id.startsWith('group_chat.') && assertion.status !== 'PASS') {
      throw new Error('Group chat checks did not all pass');
    }
  }
}

function initialiseAssertions(assertions: Phase4Assertion[]): void {
  for (const [id, statement] of assertionNames) {
    assertions.push({ id, status: 'NOT PROVEN', statement,
      evidence: { reason: 'This check has not run yet.' }, screenshots: [] });
  }
}

function setAssertion(assertions: Phase4Assertion[], id: string, passed: boolean,
  evidence: Phase4Assertion['evidence'], screenshots: string[]): void {
  const assertion = assertions.find(findAssertion.bind(null, id));
  assert(assertion, `Missing assertion row: ${id}`);
  assertion.status = passed ? 'PASS' : 'FAIL';
  assertion.evidence = evidence;
  assertion.screenshots = screenshots;
}

function findAssertion(id: string, assertion: Phase4Assertion): boolean {
  return assertion.id === id;
}

function markUnprovenAssertions(assertions: Phase4Assertion[], reason: string): void {
  for (const assertion of assertions) {
    if (assertion.id.startsWith('group_chat.') && assertion.status === 'NOT PROVEN') {
      assertion.evidence = { reason };
    }
  }
}

async function recordFailedStep(assertions: Phase4Assertion[], id: string, error: unknown,
  page: Page, output: string, screenshotName: string): Promise<void> {
  const screenshots = await captureBoth(page, output, screenshotName);
  setAssertion(assertions, id, false, { reason: errorMessage(error) }, screenshots);
}

async function openDraft(page: Page, origin: string): Promise<void> {
  await page.goto(`${origin}/workspace/direct`);
  await page.locator('#colleague-search').waitFor();
}

async function selectColleague(page: Page, name: string): Promise<void> {
  const search = page.locator('#colleague-search');
  await search.fill(name);
  const option = page.locator('.colleague-option').filter({ hasText: name });
  await option.waitFor({ state: 'visible' });
  await option.click();
}

async function inspectPicker(page: Page, output: string, longName: string): Promise<{
  passed: boolean; evidence: Record<string, string | number | boolean | string[]>;
  screenshots: string[];
}> {
  await selectColleague(page, longName);
  const modeNote = await page.locator('.mode-note').innerText();
  const longNamesShown = (await page.locator('.selected-people').innerText()).includes(longName);
  await page.locator('#colleague-search').fill('No such colleague');
  await page.getByText('No colleagues match this search.', { exact: true }).waitFor();
  const noMatchesShown = await page.getByText('No colleagues match this search.',
    { exact: true }).isVisible();
  await page.locator('#colleague-search').fill('');
  const screenshots = await captureBoth(page, output, 'group-picker');
  return { passed: longNamesShown && noMatchesShown,
    evidence: { longNamesShown, noMatchesShown, modeNote }, screenshots };
}

async function deniedParticipantSelection(page: Page, origin: string, conversationId: string,
  output: string): Promise<{ denied: boolean; status: number; addControlHidden: boolean;
    screenshots: string[] }> {
  await page.getByRole('button', { name: 'Participants', exact: true }).click();
  const participantResponse = await page.request.get(
    `${origin}/api/conversations/${conversationId}/participants`);
  assert.equal(participantResponse.status(), 200);
  const participants = await participantResponse.json() as { accessPosition: number };
  const addControlHidden = await page.locator('.participant-search input').count() === 0;
  const response = await page.request.post(
    `${origin}/api/conversations/${conversationId}/participants`, {
      headers: { origin },
      data: { id: randomUUID(), action: 'add', participantId: 'p4-5-later-participant',
        expectedAccessPosition: participants.accessPosition },
    });
  const screenshots = await captureBoth(page, output, 'group-denied-selection');
  return { denied: response.status() === 403 && addControlHidden,
    status: response.status(), addControlHidden, screenshots };
}

async function removeSelectedPerson(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: `Remove ${name}`, exact: true }).click();
}

type ColleagueRow = { memberId: string; displayName: string | null };

async function readColleagues(page: Page, origin: string): Promise<ColleagueRow[]> {
  const response = await page.request.get(`${origin}/api/chat/colleagues?limit=50`);
  assert.equal(response.status(), 200);
  const body = await response.json() as { rows: ColleagueRow[] };
  return body.rows;
}

function colleagueById(rows: ColleagueRow[], memberId: string): ColleagueRow | undefined {
  return rows.find(matchesMemberId.bind(null, memberId));
}

function matchesMemberId(memberId: string, row: ColleagueRow): boolean {
  return row.memberId === memberId;
}

async function refuseUnsupportedCombination(page: Page, output: string): Promise<{
  passed: boolean; evidence: Record<string, string | number | boolean | string[]>;
  screenshots: string[];
}> {
  const previous = await readConversations(page, new URL(page.url()).origin);
  const previousIds = new Set(previous.map(readConversationId));
  await page.getByRole('button', { name: 'Choose one assistant', exact: true }).click();
  const message = 'People and an assistant cannot share a new conversation. Remove the people first.';
  await page.getByRole('alert').filter({ hasText: message }).waitFor();
  const conversations = await readConversations(page, new URL(page.url()).origin);
  const noDraftWasSaved = conversations.every(isKnownConversation.bind(null, previousIds));
  const refused = (await page.getByRole('alert').innerText()).includes(message)
    && noDraftWasSaved;
  const screenshots = await captureBoth(page, output, 'group-unsupported-combination');
  return { passed: refused, evidence: { refused, noDraftWasSaved,
    savedConversationCount: conversations.length },
    screenshots };
}

function isKnownConversation(ids: Set<string>, row: ConversationRow): boolean {
  return ids.has(row.conversationId);
}

export async function readConversations(page: Page, origin: string): Promise<ConversationRow[]> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const timeout = Math.max(1, deadline - Date.now());
    const requestOptions = { timeout };
    const response = await page.request.get(`${origin}/api/conversations`, requestOptions);
    const status = response.status();
    if (status === 409 || status === 425) {
      await delay(250);
      continue;
    }
    assert.equal(status, 200);
    const body = await response.json() as { rows: ConversationRow[] };
    return body.rows;
  }
  throw new Error('The conversation list did not settle within fifteen seconds');
}

async function readConversation(page: Page, origin: string,
  conversationId: string): Promise<ConversationRow> {
  const rows = await readConversations(page, origin);
  const row = rows.find(findConversation.bind(null, conversationId));
  assert(row, `Conversation ${conversationId} was not returned to this participant`);
  return row;
}

function findConversation(id: string, row: ConversationRow): boolean {
  return row.conversationId === id;
}

async function sendMessage(page: Page, text: string): Promise<{
  displayMs: number; displayedAtMs: number; commandId: string;
}> {
  const composer = page.locator('#message');
  await composer.waitFor({ state: 'visible', timeout: 10_000 });
  await composer.fill(text);
  let acceptedAt = 0;
  function savedSend(response: BrowserResponse): boolean {
    if (response.request().method() !== 'POST' || !response.url().endsWith('/messages')
      || response.status() !== 200) {
      return false;
    }
    acceptedAt = performance.now();
    return true;
  }
  const accepted = page.waitForResponse(savedSend, { timeout: 10_000 });
  await composer.press('Enter');
  const response = await accepted;
  const command = response.request().postDataJSON() as { id: string };
  // Include projection time: a row cannot be projected before this send was saved.
  await page.getByText(text, { exact: true }).waitFor({ state: 'visible', timeout: 2_000 });
  const displayMs = Math.round(performance.now() - acceptedAt);
  assert(displayMs <= 2_000, `Saved group message appeared after ${displayMs} ms`);
  return { displayMs, displayedAtMs: Date.now(), commandId: command.id };
}

async function waitForNewConversation(page: Page, origin: string,
  previous: ConversationRow[]): Promise<string> {
  const oldIds = new Set(previous.map(readConversationId));
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const rows = await readConversations(page, origin);
    const row = rows.find(isNewGroup.bind(null, oldIds));
    if (row) return row.conversationId;
    await delay(100);
  }
  throw new Error('The first send did not create a group conversation');
}

function readConversationId(row: ConversationRow): string {
  return row.conversationId;
}

function isNewGroup(oldIds: Set<string>, row: ConversationRow): boolean {
  return !oldIds.has(row.conversationId) && row.mode === 'group';
}

async function waitForMessage(page: Page, text: string): Promise<void> {
  await page.getByText(text, { exact: true }).waitFor({ state: 'visible', timeout: 15_000 });
}

async function hasMessage(page: Page, text: string): Promise<boolean> {
  return page.getByText(text, { exact: true }).isVisible().catch(returnFalse);
}

function returnFalse(): false {
  return false;
}

async function openConversation(page: Page, origin: string, id: string): Promise<void> {
  const conversationUrl = `${origin}/workspace/direct?conversation=`
    + encodeURIComponent(id);
  await page.goto(conversationUrl);
  const rows = await readConversations(page, origin);
  const conversation = rows.find(findConversation.bind(null, id));
  assert(conversation, `Participant cannot find conversation ${id}`);
  await page.getByRole('button', { name: 'Participants', exact: true }).waitFor({
    state: 'visible', timeout: 15_000,
  });
}

async function addParticipant(page: Page, origin: string, id: string,
  name: string): Promise<void> {
  await openConversation(page, origin, id);
  await page.getByRole('button', { name: 'Participants', exact: true }).click();
  await page.locator('.participant-search input').fill(name);
  const eligible = page.locator('.eligible-list li').filter({ hasText: name });
  await eligible.getByRole('button', { name: 'Add', exact: true }).click();
  const participants = page.locator('.participant-list').first();
  await participants.getByText(name, { exact: true }).waitFor({
    state: 'visible', timeout: 10_000,
  });
  const backToConversation = page.locator('.participant-back');
  if (await backToConversation.isVisible()) await backToConversation.click();
  await openConversation(page, origin, id);
  await page.locator('#message').waitFor({ state: 'visible', timeout: 10_000 });
}

async function leaveConversation(page: Page, origin: string, id: string): Promise<number> {
  await openConversation(page, origin, id);
  await page.getByRole('button', { name: 'Participants', exact: true }).click();
  const startedAt = Date.now();
  await page.getByRole('button', { name: 'Leave conversation', exact: true }).click();
  return startedAt;
}

async function observeClearedAccess(page: Page, oldMessage: string,
  startedAt: number): Promise<{
  cleared: boolean; elapsedMs: number; transcriptEmpty: boolean;
}> {
  const deadline = startedAt + 2_000;
  while (Date.now() < deadline) {
    const pageState = await page.locator('.transcript').innerText();
    if (pageState.includes('You no longer have access') && !pageState.includes(oldMessage)) {
      return { cleared: true, elapsedMs: Date.now() - startedAt, transcriptEmpty: true };
    }
    await delay(50);
  }
  const pageState = await page.locator('.transcript').innerText();
  return { cleared: false, elapsedMs: Date.now() - startedAt,
    transcriptEmpty: !pageState.includes(oldMessage) };
}

async function waitForParticipantAbsent(list: Locator, name: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await list.getByText(name, { exact: true }).count() === 0) return;
    await delay(100);
  }
  assert.equal((await list.innerText()).includes(name), false,
    'The remaining participants see that the colleague left');
}

async function countActivity(store: EventStore): Promise<ActivityCounts> {
  const head = await store.head();
  const counts: ActivityCounts = { aiEvents: [], computerEvents: [], budgetEvents: [] };
  if (!head) return counts;
  for await (const stored of readEvents(store, 1, head)) {
    const eventDetail = `#${stored.sequence} ${stored.event.type} on ${stored.event.subject}`;
    if (stored.event.type === 'decision.recorded') counts.aiEvents.push(eventDetail);
    if (stored.event.type.startsWith('computer.')) counts.computerEvents.push(eventDetail);
    if (stored.event.type.startsWith('budget.')) counts.budgetEvents.push(eventDetail);
  }
  return counts;
}

async function waitForStableActivity(store: EventStore): Promise<ActivityCounts> {
  let previous = await countActivity(store);
  let repeatedSnapshots = 0;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && repeatedSnapshots < 2) {
    await delay(500);
    const current = await countActivity(store);
    if (sameCounts(previous, current)) repeatedSnapshots += 1;
    else repeatedSnapshots = 0;
    previous = current;
  }
  return previous;
}

async function waitForComputersToSettle(store: EventStore): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await hasPendingComputer(store)) {
      await delay(250);
      continue;
    }
    const before = await countActivity(store);
    await delay(1_000);
    const after = await countActivity(store);
    if (sameCounts(before, after) && !await hasPendingComputer(store)) return;
  }
  throw new Error('A computer was still starting before the ordinary group messages.');
}

async function hasPendingComputer(store: EventStore): Promise<boolean> {
  const head = await store.head();
  if (!head) return false;
  const latestComputerEventByStream = new Map<string, string>();
  for await (const stored of readEvents(store, 1, head)) {
    if (stored.event.type.startsWith('computer.')) {
      latestComputerEventByStream.set(stored.event.subject, stored.event.type);
    }
  }
  for (const eventType of latestComputerEventByStream.values()) {
    if (isComputerStarting(eventType)) return true;
  }
  return false;
}

function isComputerStarting(eventType: string): boolean {
  return eventType === 'computer.claimed' || eventType === 'computer.resumed';
}

function sameCounts(first: ActivityCounts, second: ActivityCounts): boolean {
  return sameStrings(first.aiEvents, second.aiEvents)
    && sameStrings(first.computerEvents, second.computerEvents)
    && sameStrings(first.budgetEvents, second.budgetEvents);
}

function activityBetweenSends(beforeFirst: ActivityCounts | undefined,
  afterFirst: ActivityCounts | undefined, beforeSecond: ActivityCounts,
  afterSecond: ActivityCounts): ActivityCounts {
  assert(beforeFirst && afterFirst, 'Both group message activity snapshots are required');
  return {
    aiEvents: [...newEvents(beforeFirst.aiEvents, afterFirst.aiEvents),
      ...newEvents(beforeSecond.aiEvents, afterSecond.aiEvents)],
    computerEvents: [...newEvents(beforeFirst.computerEvents, afterFirst.computerEvents),
      ...newEvents(beforeSecond.computerEvents, afterSecond.computerEvents)],
    budgetEvents: [...newEvents(beforeFirst.budgetEvents, afterFirst.budgetEvents),
      ...newEvents(beforeSecond.budgetEvents, afterSecond.budgetEvents)],
  };
}

function newEvents(before: string[], after: string[]): string[] {
  const previousEvents = new Set(before);
  return after.filter(isNewEvent.bind(null, previousEvents));
}

function isNewEvent(previousEvents: Set<string>, event: string): boolean {
  return !previousEvents.has(event);
}

function sameStrings(first: string[], second: string[]): boolean {
  return first.length === second.length && first.every(matchesString.bind(null, second));
}

function matchesString(values: string[], value: string): boolean {
  return values.includes(value);
}

async function captureBoth(page: Page, output: string, name: string): Promise<string[]> {
  const screenshots: string[] = [];
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const destination = resolve(output, `${name}-${width}.png`);
    await page.screenshot({ path: destination, fullPage: false, animations: 'disabled',
      mask: [page.getByText(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu),
        page.locator('input[type=email], input[value*="@"]')] });
    screenshots.push(destination);
  }
  return screenshots;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown group chat journey error';
}
