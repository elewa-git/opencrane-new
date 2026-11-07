import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { checkNative } from './native-checks.ts';

function requireSilo(siloId: string): void {
  const silo = process.env['SILO_ID'];
  if (!silo) {
    throw new Error('journey_unavailable');
  }
  const hash = createHash('sha256');
  hash.update(silo);
  if (`sha256:${hash.digest('hex')}` !== siloId) {
    throw new Error('journey_unavailable');
  }
}

export async function checkRecallPrerequisites(siloId: string, challengeId: string): Promise<void> {
  requireSilo(siloId);
  await checkNative(challengeId);
  requireSilo(siloId);
  // Keep recall NOT RUN: empty native threads do not prove a memory-bearing answer.
}

type Binding = {
  sourceSha: string; imageDigest: string; siloId: string; installationId: string;
  challengeId: string; requesterId: string; conversationId: string; turnId: string;
  threadId: string; generation: number; inputGeneration: number; processId: string;
};
type Reference = { scopeId: string; memoryId: string; revision: number };
type Observation = {
  binding: Binding; current: Reference | undefined; references: Reference[];
  active: boolean; fresh: boolean; expiresAt: number; nativeDigest: string;
};
type Driver = {
  // Read saved history and current revisions before checking the small grant streams.
  read(): Promise<Observation>;
  now(): number;
  protectedHost(): boolean;
  // Call loaded before releasing recall bytes. Feed receive only from this native connection.
  dispatch(question: string, loaded: () => Promise<boolean>,
    receive: (value: unknown) => void): Promise<string>;
};
type Outcome = { result: 'PARTIAL'; complete: false }
  | { result: 'FAIL'; reason: 'journey_failed'; complete: false };
const refused: Outcome = { result: 'FAIL', reason: 'journey_failed', complete: false };
const nativeDigest = '1748767b230ebfc3d4ab7e4e254920d0c0ad9691fd8c11f190e7d44511a4a92e';

function sameReference(actual: Reference | undefined, expected: Reference): boolean {
  return actual?.scopeId === expected.scopeId && actual.memoryId === expected.memoryId
    && actual.revision === expected.revision;
}

const nativeObject = z.record(z.string(), z.unknown());
function object(value: unknown): Record<string, unknown> {
  const parsed = nativeObject.safeParse(value);
  if (!parsed.success) {
    return {};
  }
  return parsed.data;
}

function nativeAnswer(binding: Binding, expected: Buffer, question: string) {
  let matched = false;
  let failed = false;
  let completed = false;
  let nativeTurn: unknown;
  function receive(value: unknown) {
    const event = object(value);
    const params = object(event['params']);
    if (params['threadId'] !== binding.threadId || completed) {
      failed = true;
      return;
    }
    if (event['method'] === 'item/completed') {
      const item = object(params['item']);
      if (item['type'] !== 'agentMessage') {
        return;
      }
      const answer = item['text'];
      if (typeof answer !== 'string' || Buffer.byteLength(answer) > 65_536 || matched) {
        failed = true;
        return;
      }
      nativeTurn = params['turnId'];
      const bytes = Buffer.from(answer);
      matched = answer !== question && bytes.includes(expected);
      bytes.fill(0);
    } else if (event['method'] === 'turn/completed') {
      const turn = object(params['turn']);
      completed = turn['id'] === nativeTurn && turn['status'] === 'completed';
      if (!completed) {
        failed = true;
      }
    } else if (event['method'] === 'thread/closed' || event['method'] === 'error') {
      failed = true;
    }
  }
  function accepted(turnId: string) {
    return !failed && matched && completed && nativeTurn === turnId;
  }
  return { receive, accepted };
}

// Keep this local checker separate from deployment qualification: its driver must be measured.
export function recallAnswerCheck(
  binding: Binding, reference: Reference, answer: string, question: string, driver: Driver,
): () => Promise<Outcome> {
  const expectedBinding = { ...binding };
  const expectedReference = { ...reference };
  const expected = Buffer.from(answer);
  const validInput = expected.length > 0 && expected.length <= 4096
    && question.length > 0 && Buffer.byteLength(question) <= 4096 && !question.includes(answer);
  const native = nativeAnswer(expectedBinding, expected, question);
  let used = false;
  let failed = false;
  let loaded = false;
  let loading = false;
  let dispatching = false;
  let deadline = 0;
  function protectedNow() {
    return !failed && driver.protectedHost() && driver.now() < deadline;
  }
  async function inspect(requireLoaded: boolean) {
    if (!protectedNow()) {
      return false;
    }
    const observed = await driver.read();
    if (!protectedNow() || !isDeepStrictEqual(observed.binding, expectedBinding)
      || observed.nativeDigest !== nativeDigest || !observed.active
      || !Number.isFinite(observed.expiresAt) || observed.expiresAt <= driver.now()
      || !sameReference(observed.current, expectedReference)) {
      return false;
    }
    if (!requireLoaded) {
      return observed.fresh && observed.references.length === 0;
    }
    return observed.references.length === 1
      && sameReference(observed.references[0], expectedReference);
  }
  async function beforeDelivery() {
    if (!dispatching || loading) {
      failed = true;
      return false;
    }
    loading = true;
    if (!await inspect(true)) {
      failed = true;
      return false;
    }
    loaded = true;
    return true;
  }
  function receive(value: unknown) {
    const event = object(value);
    const params = object(event['params']);
    const item = object(params['item']);
    const answerOutput = event['method'] === 'item/agentMessage/delta'
      || event['method'] === 'turn/completed' || item['type'] === 'agentMessage';
    if (!dispatching || (answerOutput && !loaded) || !protectedNow()) {
      failed = true;
      return;
    }
    native.receive(value);
  }
  async function run(): Promise<Outcome> {
    if (used) {
      failed = true;
      return refused;
    }
    used = true;
    try {
      deadline = driver.now() + 120_000;
      if (!validInput || !await inspect(false)) {
        return refused;
      }
      dispatching = true;
      const nativeTurn = await driver.dispatch(question, beforeDelivery, receive);
      dispatching = false;
      if (!loaded || !native.accepted(nativeTurn) || !await inspect(true)) {
        return refused;
      }
      return { result: 'PARTIAL', complete: false };
    } catch {
      return refused;
    } finally {
      dispatching = false;
      failed = true;
      expected.fill(0);
    }
  }
  return run;
}
