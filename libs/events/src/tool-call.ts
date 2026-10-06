/** Accept provider call ids and tool names without storing control characters. */
export function isToolCallText(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  if (value.length < 1 || value.length > 200) {
    return false;
  }
  return !/\p{C}/u.test(value);
}
