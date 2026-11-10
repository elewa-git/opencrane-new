import { parseTurn } from '../../src/turn-frame.ts';

export function parseComputerTurn(value: Record<string, unknown>) {
  return parseTurn(value);
}
