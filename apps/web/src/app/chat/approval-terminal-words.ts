import type { ApprovalCard } from '@opencrane/protocol';
import { utcDateTime } from './file-presentation';

type CancelReason = NonNullable<ApprovalCard['cancelReason']>;
type TerminalGlyph = 'done' | 'clock' | 'block' | 'dash' | 'failed' | 'closed';

interface ReasonWords {
  words: string;
  glyph: TerminalGlyph;
}

export interface ApprovalTimeRow {
  label: string;
  time: string;
}

const cancellationWords: Record<CancelReason, ReasonWords> = {
  turn_ended: { words: 'Cancelled: turn ended', glyph: 'dash' },
  turn_stopped: { words: 'Cancelled: turn stopped', glyph: 'dash' },
  new_message: { words: 'Cancelled: new message', glyph: 'dash' },
  new_turn: { words: 'Cancelled: new turn', glyph: 'dash' },
  conversation_closed: { words: 'Cancelled: conversation closed', glyph: 'dash' },
  unpublished: { words: 'No longer valid: tool unpublished', glyph: 'failed' },
  connection_changed: { words: 'No longer valid: connection changed', glyph: 'failed' },
  policy_changed: { words: 'No longer valid: policy changed', glyph: 'failed' },
  grant_revoked: { words: 'No longer valid: a tool grant was revoked', glyph: 'closed' },
  schema_changed: { words: 'No longer valid: tool schema changed', glyph: 'failed' },
  profile_changed: { words: 'No longer valid: profile changed', glyph: 'failed' },
};

function useCount(card: ApprovalCard): number {
  const savedUses = card.uses?.length ?? 0;
  if (savedUses > 0) {
    return savedUses;
  }
  return card.usedAt || card.state === 'outcome_unknown' ? 1 : 0;
}

function useWords(card: ApprovalCard): string {
  const count = useCount(card);
  if (count === 1) {
    return 'used once';
  }
  return `used ${count} times`;
}

function firstUseTime(card: ApprovalCard): string | undefined {
  return card.usedAt ?? card.uses?.[0]?.usedAt;
}

function addTime(rows: ApprovalTimeRow[], label: string, savedTime: string | undefined): void {
  if (!savedTime) {
    return;
  }
  const row = { label, time: utcDateTime(savedTime) };
  rows.push(row);
}

export function approvalTimeRows(card: ApprovalCard): ApprovalTimeRow[] {
  const rows: ApprovalTimeRow[] = [];
  addTime(rows, 'Requested', card.requestedAt);
  addTime(rows, 'Decided', card.decidedAt);
  if (card.uses?.length) {
    for (const use of card.uses) {
      addTime(rows, 'Used', use.usedAt);
    }
  } else {
    addTime(rows, 'Used', card.usedAt);
  }
  const endLabel = card.state === 'expired' ? 'Expiry recorded' : 'Ended';
  addTime(rows, endLabel, card.endedAt);
  return rows;
}

export function terminalWords(card: ApprovalCard): string | undefined {
  if (card.state !== 'cancelled') {
    return undefined;
  }
  if (!card.cancelReason) {
    return 'Cancelled';
  }
  return cancellationWords[card.cancelReason].words;
}

export function terminalGlyph(card: ApprovalCard): TerminalGlyph {
  if (card.state === 'approved' || card.state === 'outcome_unknown') {
    return 'done';
  }
  if (card.state === 'expired') {
    return 'clock';
  }
  if (card.state === 'denied') {
    return 'block';
  }
  if (card.cancelReason) {
    return cancellationWords[card.cancelReason].glyph;
  }
  return 'dash';
}

export function terminalUseWords(card: ApprovalCard): string | undefined {
  if (useCount(card) === 0) {
    return undefined;
  }
  return useWords(card);
}

export function terminalDetail(card: ApprovalCard): string {
  const parts: string[] = [];
  if (card.state === 'approved' || card.state === 'denied') {
    if (card.decidedAt) {
      parts.push(utcDateTime(card.decidedAt));
    }
  } else if (card.state === 'outcome_unknown') {
    const usedAt = firstUseTime(card);
    if (usedAt) {
      parts.push(utcDateTime(usedAt));
    }
  } else if (card.state === 'expired') {
    parts.push(utcDateTime(card.expiresAt));
  } else if (card.endedAt) {
    parts.push(utcDateTime(card.endedAt));
  }

  if (card.state === 'approved' && useCount(card) === 0) {
    parts.push('not used yet');
  } else if (card.state === 'outcome_unknown') {
    parts.push('can’t be reused');
  } else if (useCount(card) > 0) {
    parts.push(`${useWords(card)} · no confirmed result`);
  } else {
    parts.push('nothing was sent with this approval');
  }
  return parts.join(' · ');
}
