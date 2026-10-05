import type { Writable, Readable } from 'node:stream';
import { record } from './http.ts';
import { createInterface } from 'node:readline';

type Handlers = {
  message(message: Record<string, unknown>, line: string): void;
  failed(): void;
};
type PendingCall = { resolve(value: unknown): void; reject(error: Error): void };

export function codexConnection(input: Writable, output: Readable, handlers: Handlers) {
  const pending = new Map<string, PendingCall>();
  let nextRpc = 0;
  let failed = false;
  function rejectPending() {
    for (const call of pending.values()) call.reject(new Error('Codex connection closed'));
    pending.clear();
  }
  function invalidOutput() {
    if (failed) return;
    failed = true;
    rejectPending();
    handlers.failed();
  }
  function receive(line: string) {
    if (failed) return;
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        invalidOutput();
        return;
      }
      message = record(parsed);
    } catch {
      // Keep JSON parser errors private: Node includes the rejected input in their messages.
      invalidOutput();
      return;
    }
    const id = message['id'];
    const call = typeof id === 'string' ? pending.get(id) : undefined;
    if (call && typeof message['method'] !== 'string') {
      pending.delete(String(id));
      if (message['error']) call.reject(new Error('Codex request failed'));
      else call.resolve(message['result']);
      return;
    }
    handlers.message(message, line);
  }
  const lines = createInterface({ input: output });
  lines.on('line', receive);
  lines.on('close', rejectPending);
  output.on('error', invalidOutput);
  input.on('error', invalidOutput);
  function write(value: unknown) {
    if (failed || input.destroyed || input.writableEnded) throw new Error('Codex connection closed');
    input.write(JSON.stringify(value) + '\n');
  }
  function rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (failed || input.destroyed || input.writableEnded) {
      return Promise.reject(new Error('Codex connection closed'));
    }
    const id = `bridge-${++nextRpc}`;
    function register(resolve: (value: unknown) => void, reject: (error: Error) => void) {
      function timedOut() {
        pending.delete(id);
        reject(new Error('Codex request timed out'));
      }
      const timeout = setTimeout(timedOut, 30_000);
      function resolved(value: unknown) { clearTimeout(timeout); resolve(value); }
      function rejected(error: Error) { clearTimeout(timeout); reject(error); }
      pending.set(id, { resolve: resolved, reject: rejected });
      try { write({ id, method, params }); }
      catch { pending.delete(id); rejected(new Error('Codex connection closed')); }
    }
    return new Promise(register);
  }
  function notify(method: string, params: Record<string, unknown>) { write({ method, params }); }
  function reply(id: unknown, error: { code: number; message: string }) { write({ id, error }); }
  return { rpc, notify, reply };
}
