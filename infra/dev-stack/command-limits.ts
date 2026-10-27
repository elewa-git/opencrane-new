export type CommandLimits = { deadline?: number; signal?: AbortSignal };

export function commandTimeout(timeoutMs: number, limits: CommandLimits) {
  limits.signal?.throwIfAborted();
  if (limits.deadline === undefined) {
    return timeoutMs;
  }
  const remainingMs = limits.deadline - Date.now();
  if (remainingMs <= 0) {
    throw new Error('Command deadline expired');
  }
  return Math.min(timeoutMs, remainingMs);
}
