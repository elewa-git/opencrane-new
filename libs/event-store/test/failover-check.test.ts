import { expect, it } from 'vitest';
import { checkQuorumLoss, checkSurvival, type Receipt } from './failover-check.ts';

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

function refusesFalseSuccess() {
  function check() {
    checkQuorumLoss('appended', 'unresolved');
  }
  expect(check).toThrow('Write reported success without quorum');
}
it('refuses a false acknowledged outcome without quorum', refusesFalseSuccess);

function refusesAssumedAbsence() {
  function check() {
    checkQuorumLoss('unavailable', 'absent');
  }
  expect(check).toThrow('Unavailable work must stay unresolved');
}
it('refuses unresolved work labelled absent', refusesAssumedAbsence);

function acceptsUncertainWrite() {
  expect(checkQuorumLoss('unavailable', 'unresolved')).toBeUndefined();
}
it('accepts only an explicitly unresolved unavailable write', acceptsUncertainWrite);

function refusesMissingAcknowledgement() {
  function check() {
    checkSurvival([first, second], [first, second, third],
      { 'member-alice': 1, 'member-bob': 2 }, []);
  }
  expect(check).toThrow('Acknowledged event changed or missing');
}
it('refuses a missing final event even when remaining positions agree',
  refusesMissingAcknowledgement);

function refusesContiguousDuplicate(change: string) {
  const duplicate = { ...third, id: first.id };
  if (change === 'command') {
    duplicate.id = 'different-event';
    duplicate.commandId = first.commandId;
  }
  function check() {
    checkSurvival([first, second, duplicate], [], positions, []);
  }
  const reason = change === 'event' ? 'Repeated event' : 'Repeated command';
  expect(check).toThrow(reason);
}
it.each(['event', 'command'])('refuses a contiguous duplicate %s', refusesContiguousDuplicate);

function refusesRepeatedAcknowledgement() {
  function check() {
    checkSurvival(acknowledged, [first, first], positions, []);
  }
  expect(check).toThrow('Repeated acknowledgement');
}
it('refuses a repeated acknowledgement', refusesRepeatedAcknowledgement);

function refusesChangedAcknowledgement(field: string) {
  const changed: Record<string, unknown> = { ...third };
  if (field === 'missing commandId') {
    delete changed.commandId;
  } else {
    changed[field] = field === 'sequence' ? 2 : 'changed';
  }
  function check() {
    checkSurvival(acknowledged, [changed as unknown as Receipt], positions, []);
  }
  expect(check).toThrow('Acknowledged event changed or missing');
}
it.each(['id', 'commandId', 'subject', 'sequence', 'missing commandId'])(
  'refuses changed acknowledgement metadata: %s', refusesChangedAcknowledgement);
