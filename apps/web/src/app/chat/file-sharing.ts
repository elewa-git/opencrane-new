import type { WritableSignal } from '@angular/core';
import type { ChatSession } from './chat-session';

export async function sendDraft(
  chat: ChatSession, draft: WritableSignal<string>, text: string,
): Promise<void> {
  const sent = await chat.send(text);
  if (sent) {
    draft.set('');
  }
}

export function canShareFile(chat: ChatSession, draft: WritableSignal<string>): boolean {
  // Keep Share from replacing a draft or attaching files meant for another message.
  // Let a queued request finish or retry before starting a different one.
  return chat.canSend('Share') && !chat.queued() && !draft()
    && chat.uploadBatch.chips().length === 0;
}

export async function requestFileShare(
  chat: ChatSession, draft: WritableSignal<string>, path: string,
): Promise<void> {
  if (!canShareFile(chat, draft)) {
    return;
  }
  const quotedPath = JSON.stringify(path);
  const request = `Please share a fresh copy of ${quotedPath} in this chat.`;
  // Keep the request in the composer if sending fails, so its normal Retry remains usable.
  draft.set(request);
  await sendDraft(chat, draft, request);
}
