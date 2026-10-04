export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** These checks keep untrusted identifiers and names inside their intended upload paths. */
export function isSafeId(value: string) {
  return /^[\w-]{1,200}$/u.test(value);
}

export function isSafeFileName(value: string) {
  return /^[\w][\w .()-]{0,119}$/u.test(value);
}
