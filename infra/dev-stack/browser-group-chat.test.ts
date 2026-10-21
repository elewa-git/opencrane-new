import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import type { Page } from 'playwright';
import type { EventStore } from '@opencrane/event-store';
import type { Phase4Assertion } from './browser-phase4.ts';
import { browserGroupChat } from './browser-group-chat.ts';

async function propagatesAnIncompleteJourney() {
  const directory = await mkdtemp(`${tmpdir()}/group-journey-failure-`);
  const assertions: Phase4Assertion[] = [];
  async function goto() { throw new Error('Fixture page could not open'); }
  async function restartConversations() { assert.fail('Restart must not be reached'); }
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
