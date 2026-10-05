import type { IntegrationRow } from '@opencrane/protocol';

export function needsAttention(row: IntegrationRow): boolean {
  return ['needs_input', 'failed', 'unknown', 'access_changed'].includes(row.status.kind);
}

export function needsReview(row: IntegrationRow): boolean {
  const detail = row.status.detail.toLowerCase();
  return row.status.kind === 'needs_input' && detail.includes('pending review');
}
