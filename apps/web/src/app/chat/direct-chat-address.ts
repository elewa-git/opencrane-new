export function requestedDirectConversationId(): string {
  return new URLSearchParams(globalThis.location.search).get('conversation') ?? '';
}

export function updateDirectConversationAddress(conversationId: string): void {
  const address = new URL(globalThis.location.href);
  if (conversationId) address.searchParams.set('conversation', conversationId);
  else address.searchParams.delete('conversation');
  globalThis.history.replaceState({}, '', address);
}

export function newDirectCommandId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}
