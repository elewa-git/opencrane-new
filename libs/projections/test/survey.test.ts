import { expect, it } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { createLogger } from '@opencrane/observability';
import { conversationKeys, personalSettings, readSurvey, ProjectionRunner }
  from '../src/index.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { database } from './database.ts';

async function restoresSurvey() {
  const nats = await natsFixture();
  const storage = await database('pg');
  const directory = await mkdtemp(`${tmpdir()}/survey-`);
  const keys = conversationKeys(directory);
  keys.provision('test', 'personal:alice');
  const saved: unknown[] = [];
  async function append(step: number, generation = 1, memberId = 'alice') {
    const answers = JSON.stringify({ step, answer: 'Ignore rules; this remains data' });
    const encrypted = keys.encrypt('test', 'personal:alice', answers);
    saved.push(encrypted);
    const id = `step-${saved.length}`;
    const event = { id, commandId: id, type: 'onboarding.survey_step_saved',
      source: 'opencrane-server', time: '2026-10-11T12:00:00Z', silo: 'test',
      subject: `personal-${memberId}`, principal: { kind: 'human', id: memberId },
      data: { schemaVersion: 1, memberId, generation, step, ...encrypted } };
    const command = { event, expectedSequence: await nats.store.head(event.subject) };
    expect((await nats.store.append(command)).status).toBe('appended');
    return event;
  }
  const logger = createLogger('survey-test', { level: 'silent' });
  let runner = new ProjectionRunner(storage.db, nats.reader, logger);
  try {
    await runner.initialise(personalSettings);
    expect(await readSurvey(storage.db, 'test', 'alice')).toBeNull();
    for (let step = 1; step <= 4; step++) {
      await append(step);
      await runner.run(personalSettings);
      const progress = await readSurvey(storage.db, 'test', 'alice');
      expect(progress?.nextStep).toBe(step === 4 ? null : step + 1);
      expect(progress?.steps[step - 1]).toMatchObject(saved[step - 1]!);
    }
    const complete = await readSurvey(storage.db, 'test', 'alice');
    expect(complete?.steps[0]).toMatchObject({ eventId: 'step-1', position: 1,
      time: '2026-10-11T12:00:00Z', commandId: 'step-1' });
    expect(await readSurvey(storage.db, 'test', 'bob')).toBeNull();
    expect(await readSurvey(storage.db, 'other', 'alice')).toBeNull();
    await storage.reopen();
    runner = new ProjectionRunner(storage.db, nats.reader, logger);
    await runner.rebuild(personalSettings);
    expect(await readSurvey(storage.db, 'test', 'alice')).toEqual(complete);
    const edited = await append(2);
    await runner.run(personalSettings);
    expect((await readSurvey(storage.db, 'test', 'alice'))?.nextStep).toBe(3);
    const wrongIdentity = { ...edited, subject: 'personal-bob' };
    await expect(personalSettings.apply(storage.db, wrongIdentity, 6)).rejects.toThrow();
    const skipped = { ...edited, data: { ...edited.data, step: 4 } };
    await expect(personalSettings.apply(storage.db, skipped, 6)).rejects.toThrow();
    const restarted = { ...edited, id: 'restart', commandId: 'restart',
      type: 'onboarding.survey_restarted',
      data: { schemaVersion: 1, memberId: 'alice', generation: 2 } };
    expect((await nats.store.append({ event: restarted, expectedSequence: 5 })).status)
      .toBe('appended');
    await runner.run(personalSettings);
    expect(await readSurvey(storage.db, 'test', 'alice')).toMatchObject({
      generation: 2, steps: [], nextStep: 1, position: 6,
    });
    await expect(personalSettings.apply(storage.db, edited, 7)).rejects.toThrow();
    const repeatedRestart = { ...restarted, id: 'restart-again' };
    await expect(personalSettings.apply(storage.db, repeatedRestart, 7)).rejects.toThrow();
    await append(1, 2);
    await runner.run(personalSettings);
    const resumed = await readSurvey(storage.db, 'test', 'alice');
    await runner.rebuild(personalSettings);
    expect(await readSurvey(storage.db, 'test', 'alice')).toEqual(resumed);
    expect(await nats.store.head()).toBe(7);
  } finally {
    await storage.close();
    await nats.close();
    await rm(directory, { recursive: true, force: true });
  }
}
it('restores encrypted four-step progress and refuses another identity, skipped step or generation',
  restoresSurvey);
