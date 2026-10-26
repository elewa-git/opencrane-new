export function isPublicChatId(value: string) {
  // Reserve both routine-session- and its routine-session-create- subset for worker preparation.
  return !value.startsWith('routine-session-');
}
