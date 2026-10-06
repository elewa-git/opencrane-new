import { expect, it } from 'vitest';
import { lifecycleComputerState } from '@opencrane/projections';

function event(type: string) {
  const time = type === 'computer.lost' ? '2026-10-02T10:03:00.000Z'
    : '2026-10-02T10:05:00.000Z';
  return { event: { type, time } };
}

it('shows starting until the computer reports ready', () => {
  expect(lifecycleComputerState([event('computer.claimed')])).toEqual({
    computerState: 'starting', computerRecovered: false, computerLostAt: undefined,
  });
});

it('shows a ready computer before any loss', () => {
  expect(lifecycleComputerState([
    event('computer.claimed'), event('computer.ready'),
  ])).toEqual({ computerState: 'ready', computerRecovered: false, computerLostAt: undefined });
});

it('keeps a lost computer recovering until a new ready event', () => {
  expect(lifecycleComputerState([
    event('computer.ready'), event('computer.lost'), event('computer.claimed'),
  ])).toEqual({ computerState: 'recovering', computerRecovered: false,
    computerLostAt: '2026-10-02T10:03:00.000Z' });
});

it('marks a new ready computer after loss so the chat can explain recovery', () => {
  expect(lifecycleComputerState([
    event('computer.ready'), event('computer.lost'), event('computer.claimed'),
    event('computer.ready'),
  ])).toEqual({ computerState: 'ready', computerRecovered: true,
    computerLostAt: '2026-10-02T10:03:00.000Z' });
});

it('shows starting for a suspended computer and throughout a cold resume', () => {
  const ready = [event('computer.ready')];
  const suspended = [...ready, event('computer.suspended')];
  expect(lifecycleComputerState(suspended).computerState).toBe('starting');
  const resumed = [...suspended, event('computer.resumed')];
  expect(lifecycleComputerState(resumed).computerState).toBe('starting');
  expect(lifecycleComputerState([...resumed, event('computer.ready')]))
    .toMatchObject({ computerState: 'ready', computerRecovered: false });
});
