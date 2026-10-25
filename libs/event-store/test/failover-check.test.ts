import { expect, it } from 'vitest';
import { checkSurvival, type Receipt } from './failover-check.ts';

const first: Receipt = { id: 'first', commandId: 'first', subject: 'member-alice', sequence: 1 };
const second: Receipt = { id: 'second', commandId: 'second', subject: 'member-bob', sequence: 2 };
const third: Receipt = { id: 'third', commandId: 'third', subject: 'member-alice', sequence: 3 };
const acknowledged = [first, second, third];
const positions = { 'member-alice': 3, 'member-bob': 2 };

function acceptsHistory() {
  expect(checkSurvival(acknowledged, acknowledged, positions, [])).toEqual({
    acknowledged: 3, unresolved: [], observedUnresolved: [],
  });
}
it('accepts retained acknowledgements and exact subject positions', acceptsHistory);

function refusesChangedHistory(change: string) {
  let retained = [...acknowledged];
  let subjectPositions = positions;
  if (change === 'removed') {
    retained = [first, third];
  } else if (change === 'duplicated') {
    retained = [first, second, second, third];
  } else if (change === 'reordered') {
    retained = [second, first, third];
  } else if (change === 'receipt position') {
    retained = [first, second, { ...third, sequence: 4 }];
  } else {
    subjectPositions = { ...positions, 'member-bob': 3 };
  }
  function check() {
    checkSurvival(retained, acknowledged, subjectPositions, []);
  }
  expect(check).toThrow();
}
it.each(['removed', 'duplicated', 'reordered', 'receipt position', 'subject position'])(
  'refuses %s evidence', refusesChangedHistory);

function keepsUncertainOutcomesSeparate(observed: boolean) {
  const uncertain = { ...third, id: 'racing', commandId: 'racing' };
  const retained = observed ? [first, second, uncertain] : [first, second];
  const subjectPositions = { 'member-alice': observed ? 3 : 1, 'member-bob': 2 };
  const result = checkSurvival(retained, [first, second], subjectPositions, ['racing']);
  expect(result).toEqual({
    acknowledged: 2, unresolved: ['racing'], observedUnresolved: observed ? ['racing'] : [],
  });
  function claimAcknowledgement() {
    checkSurvival(retained, [first, second, uncertain], subjectPositions, ['racing']);
  }
  expect(claimAcknowledgement).toThrow();
}
it.each([false, true])('keeps a timeout unresolved when observed: %s',
  keepsUncertainOutcomesSeparate);
