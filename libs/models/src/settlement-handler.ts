import type { EventEnvelope } from '@opencrane/events';
import { registerHandler } from '@opencrane/handlers';
import { data } from './state.ts';

export function settlementHandler(decisionUrl: string) {
  async function settleBudget(event: EventEnvelope) {
    const payload = data(event);
    let path: string;
    let requestBody: Record<string, unknown>;
    if (event.type === 'computer.lost') {
      path = 'computer-lost';
      requestBody = { subject: event.subject, eventId: event.id };
    } else {
      path = 'settle';
      requestBody = { permitId: payload['permitId'], eventId: event.id };
    }
    const request = { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(requestBody), signal: AbortSignal.timeout(10_000) };
    const response = await fetch(`${decisionUrl}/${path}`, request);
    if (!response.ok) {
      throw new Error('Budget settlement unavailable');
    }
  }
  return registerHandler('settle-budget', settleBudget);
}
