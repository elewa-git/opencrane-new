import { expect, it } from 'vitest';
import { lifecycleComputerState } from '../src/chat/routes.ts';

function event(type: string) {
  return { event: { type, time: '2026-10-02T10:03:00.000Z' } };
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
