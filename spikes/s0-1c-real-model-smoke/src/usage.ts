import { costCents, type PriceTable } from './price-table.js';
import type { Reservation } from './decision-service.js';

// Only these gateway fields may be written to the real-run log. Never retain
// raw gateway diagnostics: an upstream error could repeat a credential.
export function safeUsageLine(line: string): string | undefined {
  const reservationId = /\breservation="(rsv_[a-f0-9]{16})"/.exec(line)?.[1];
  const input = /\bllmInputTokens=(\d+)\b/.exec(line)?.[1];
  const output = /\bllmOutputTokens=(\d+)\b/.exec(line)?.[1];
  if (!reservationId || !input || !output || !/\bllmStreaming=true\b/.test(line)) return;
  const inputTokens = Number(input), outputTokens = Number(output);
  if (!Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(outputTokens)) return;
  return JSON.stringify({ reservationId, inputTokens, outputTokens });
}

export function settle(lines: string[], reservations: Reservation[], table: PriceTable) {
  return reservations.map(reservation => {
    const matches = lines.flatMap(line => {
      try {
        const value = JSON.parse(line) as { reservationId: string; inputTokens: number; outputTokens: number };
        return value.reservationId === reservation.reservationId ? [value] : [];
      } catch { return []; }
    });
    if (matches.length !== 1) return { reservationId: reservation.reservationId, status: 'PARTIAL', reservedCents: reservation.worstCaseCents };
    const usage = matches[0]!;
    return { ...usage, status: 'CAPTURED', costCents: costCents(table, reservation.model, usage) };
  });
}
