import type { IntegrationRow } from '@opencrane/protocol';
import type { PresentationState } from '../shared-state/shared-state';

export function needsAttention(row: IntegrationRow): boolean {
  return ['needs_input', 'failed', 'unknown', 'access_changed'].includes(row.status.kind);
}

export function needsReview(row: IntegrationRow): boolean {
  const detail = row.status.detail.toLowerCase();
  return row.status.kind === 'needs_input' && detail.includes('pending review');
}

export type PublicationChangeState = 'loading' | 'disabled' | 'reviewing' | 'publishing' | 'applying'
  | 'unknown-review' | 'unknown-publication' | 'conflict' | 'failed' | 'confirmed';

export function publicationMessage(state: PublicationChangeState, initialReview: boolean): string {
  if (state === 'reviewing') {
    return 'Saving the exact tool review…';
  }
  if (state === 'publishing' || state === 'applying') {
    return 'Publishing the reviewed tool list. Calls stay paused until this finishes.';
  }
  if (state === 'unknown-publication') {
    return 'The change outcome is uncertain. Calls stay paused. Check the original change status.';
  }
  if (state === 'unknown-review') {
    if (!initialReview) {
      return 'The review outcome is unknown. Read the tool details again.';
    }
    return 'The review outcome is unknown. Check the original change before doing anything else.';
  }
  if (state === 'conflict') {
    return 'The tool list changed. Review again after a fresh read.';
  }
  if (state === 'failed') {
    return "Couldn't check publication progress. Calls stay paused.";
  }
  if (state === 'confirmed') {
    return 'The current publication is confirmed.';
  }
  return '';
}

export function publicationHeading(state: PublicationChangeState, name: string): string {
  if (state === 'confirmed') {
    return `${name} is ready`;
  }
  if (state === 'publishing' || state === 'applying') {
    return `Publishing ${name}`;
  }
  return name;
}

export function publicationKind(state: PublicationChangeState): PresentationState {
  if (state === 'confirmed') {
    return 'confirmed';
  }
  if (state === 'reviewing' || state === 'publishing' || state === 'applying') {
    return 'applying';
  }
  return 'unknown';
}

export function publicationStatusMessage(
  state: PublicationChangeState, initialReview: boolean,
): string {
  if (state === 'unknown-publication' || state === 'unknown-review' || state === 'failed') {
    return 'Outcome unknown';
  }
  return publicationMessage(state, initialReview);
}
