import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import type { Page } from 'playwright';
import { browserViewTimings } from './live-view-timings.ts';
import { measureFirstReplyDelta } from './live-view-reply-timing.ts';

function endpoint(chat: string, suffix: string) {
  return `https://example.test/api/conversations/${chat}/${suffix}`;
}

function viewerSocket(chat: string) {
  const events = new EventEmitter();
  return Object.assign(events, { url: () => `wss://example.test/ws/conversations/${chat}/view` });
}

function admission(chat: string, sessionId: string) {
  return { status: () => 200, url: () => endpoint(chat, 'view'),
    json: () => Promise.resolve({ sessionId }) };
}

function opensBothChatsAndTimesTheSecondReply() {
  const events = new EventEmitter();
  const subscribe: Pick<Page, 'on' | 'off'> = {
    on: events.on.bind(events),
    off: events.off.bind(events),
  };
  const stopViews = browserViewTimings(subscribe, 'first-chat');
  const stopReplies = measureFirstReplyDelta(subscribe, 'first-chat');

  async function observe() {
    const first = viewerSocket('first-chat');
    const second = viewerSocket('second-chat');
    const chat = Object.assign(new EventEmitter(), { url: () => 'wss://example.test/ws' });
    events.emit('websocket', chat);
    events.emit('response', admission('first-chat', 'first-session'));
    events.emit('websocket', first);
    first.emit('close');
    events.emit('request', { method: () => 'POST', url: () => endpoint('second-chat', 'messages') });
    events.emit('response', admission('second-chat', 'second-session'));
    events.emit('websocket', second);
    const payload = JSON.stringify({ conversationId: 'second-chat',
      row: { type: 'agent.message_delta', data: { text: 'Private reply' } } });
    chat.emit('framereceived', { payload });
    second.emit('close');
    await Promise.resolve();

    const views = stopViews();
    function isAdmission(record: (typeof views)[number]) {
      return record.stage === 'admission_response';
    }
    function sessionId(record: (typeof views)[number]) {
      return record.sessionId;
    }
    const admissions = views.filter(isAdmission);
    assert.deepEqual(admissions.map(sessionId), ['first-session', 'second-session']);
    assert.match(JSON.stringify(stopReplies()), /"firstDeltaMs":\d+/u);
  }
  return observe();
}

void test('repeat evidence includes both views and times the second chat reply',
  opensBothChatsAndTimesTheSecondReply);
