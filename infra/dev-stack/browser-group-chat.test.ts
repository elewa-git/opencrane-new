import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import type { Page } from 'playwright';
import type { EventStore } from '@opencrane/event-store';
import { waitForSharedAssistantReply, type Phase4Assertion } from './browser-phase4.ts';
import { browserGroupChat, readConversations } from './browser-group-chat.ts';

async function propagatesAnIncompleteJourney() {
  const directory = await mkdtemp(`${tmpdir()}/group-journey-failure-`);
  const assertions: Phase4Assertion[] = [];
  async function goto() {
    throw new Error('Fixture page could not open');
  }
  async function restartConversations() {
    assert.fail('Restart must not be reached');
  }
  const page = { goto } as unknown as Page;
  const options = {
    ownerPage: page, memberPages: [page], otherPage: page, thirdPage: page,
    origin: 'http://127.0.0.1:1', directory, attempt: 'fixture',
    store: {} as EventStore, assertions, restartConversations,
  };
  try {
    await assert.rejects(browserGroupChat(options), /Group chat checks did not all pass/u);
    assert.equal(assertions.length, 8);
    for (const assertion of assertions) assert.equal(assertion.status, 'NOT PROVEN');
    assert.equal(assertions[0]?.evidence['reason'], 'Fixture page could not open');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('an incomplete group journey retains its rows and fails the caller',
  propagatesAnIncompleteJourney);

async function acceptsACompletedRealPrivateReply() {
  async function waitFor() {}
  async function innerText() {
    return 'A real private answer.';
  }
  async function screenshot() {}
  function completed(name: string) {
    assert.equal(name, 'Done');
    return { waitFor };
  }
  function locator() {
    return { innerText };
  }
  const reply = { getByText: completed, locator };
  function last() {
    return reply;
  }
  function getByRole() {
    return { last };
  }
  function getByText() {
    throw new Error('A real answer is not the stand-in text');
  }
  const page = { getByRole, getByText, screenshot, locator } as unknown as Page;
  await waitForSharedAssistantReply(page, '/unused-fixture-output');
}

test('the private shared-session check accepts a completed real answer',
  acceptsACompletedRealPrivateReply);

async function readsTheListAfterARecordedChange() {
  let reads = 0;
  const body = { rows: [{ conversationId: 'saved-group', mode: 'group',
    participantIds: ['owner', 'member'] }] };
  function status() {
    return reads === 1 ? 409 : 200;
  }
  async function json() {
    return body;
  }
  const response = { status, json };
  async function get() {
    reads += 1;
    return response;
  }
  const page = { request: { get } } as unknown as Page;
  assert.deepEqual(await readConversations(page, 'http://fixture.invalid'), body.rows);
  assert.equal(reads, 2);
}

test('the group journey reads again when a recorded message changes the list',
  readsTheListAfterARecordedChange);

async function refusesAnUnfinishedPrivateReply() {
  let textReads = 0;
  let screenshots = 0;
  async function waitFor() {
    throw new Error('The reply is still streaming');
  }
  async function innerText() {
    textReads += 1;
    return 'A partial answer';
  }
  async function screenshot() {
    screenshots += 1;
  }
  function locator() {
    return { innerText };
  }
  function getByText() {
    return { waitFor };
  }
  const reply = { getByText, locator };
  function last() {
    return reply;
  }
  function getByRole() {
    return { last };
  }
  const page = { getByRole, locator, screenshot } as unknown as Page;
  async function checkReply() {
    await waitForSharedAssistantReply(page, '/unused-fixture-output');
  }
  await assert.rejects(checkReply, /The private chat did not finish its reply/u);
  assert.equal(screenshots, 1);
  assert.equal(textReads, 1, 'Read only the failure screen after the completion wait fails');
}

test('the private shared-session check refuses a reply that has not completed',
  refusesAnUnfinishedPrivateReply);

async function refusesEmptyPrivateReplies() {
  for (const text of ['', ' \t\n ']) {
    let screenshots = 0;
    async function waitFor() {}
    async function innerText() {
      return text;
    }
    async function screenshot() {
      screenshots += 1;
    }
    function locator() {
      return { innerText };
    }
    function getByText() {
      return { waitFor };
    }
    const reply = { getByText, locator };
    function last() {
      return reply;
    }
    function getByRole() {
      return { last };
    }
    const page = { getByRole, locator, screenshot } as unknown as Page;
    async function checkReply() {
      await waitForSharedAssistantReply(page, '/unused-fixture-output');
    }
    function hasEmptyAnswerCause(error: unknown) {
      assert(error instanceof Error);
      assert(error.cause instanceof Error);
      assert.match(error.cause.message, /must return a non-empty answer/u);
      return true;
    }
    await assert.rejects(checkReply, hasEmptyAnswerCause);
    assert.equal(screenshots, 1);
  }
}

test('the private shared-session check refuses empty and whitespace-only completed replies',
  refusesEmptyPrivateReplies);

async function recoversFromAnUnreadyList() {
  let reads = 0;
  const rows = [{ conversationId: 'ready-group', mode: 'group', participantIds: ['owner'] }];
  function status() {
    return reads === 1 ? 425 : 200;
  }
  async function json() {
    return { rows };
  }
  async function get() {
    reads += 1;
    return { status, json };
  }
  const page = { request: { get } } as unknown as Page;
  assert.deepEqual(await readConversations(page, 'http://fixture.invalid'), rows);
  assert.equal(reads, 2);
}

test('the group journey recovers from a 425 list read', recoversFromAnUnreadyList);

async function refusesOtherListStatuses() {
  for (const responseStatus of [201, 400, 401, 403, 404, 429, 500, 502, 503, 504]) {
    let reads = 0;
    let bodyReads = 0;
    function status() {
      return reads === 1 ? responseStatus : 200;
    }
    async function json() {
      bodyReads += 1;
      return { rows: [] };
    }
    async function get() {
      reads += 1;
      return { status, json };
    }
    const page = { request: { get } } as unknown as Page;
    async function readList() {
      return readConversations(page, 'http://fixture.invalid');
    }
    await assert.rejects(readList, { code: 'ERR_ASSERTION' });
    assert.equal(reads, 1);
    assert.equal(bodyReads, 0);
  }
}

test('the group journey immediately refuses list statuses other than 200, 409 and 425',
  refusesOtherListStatuses);
