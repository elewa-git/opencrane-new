import { createHash, randomBytes } from 'node:crypto';

interface Binding {
  turnId: string;
  conversation: string;
  generation: number;
  inputGeneration: number;
  expires: number;
}
interface Caller extends Binding {
  digest: string;
  thread?: string;
  timer: NodeJS.Timeout;
}

function digest(value: string) {
  const hash = createHash('sha256');
  hash.update(value);
  return hash.digest('hex');
}

export function privateCallers(dropped: (turnId: string, thread?: string) => void) {
  const active = new Map<string, Caller>();
  // Keep ended identities until restart so delayed registration cannot restore access.
  const used = new Set<string>();

  function remove(turnId: string) {
    const entry = active.get(turnId);
    if (!entry) return;
    active.delete(turnId);
    clearTimeout(entry.timer);
    dropped(turnId, entry.thread);
  }

  function live(turnId: string) {
    const entry = active.get(turnId);
    if (entry && Date.now() >= entry.expires) {
      remove(turnId);
      return undefined;
    }
    return entry;
  }

  function register(binding: Binding) {
    if (active.size >= 2 || used.size >= 4096 || used.has(binding.turnId)
      || !binding.turnId || !binding.conversation
      || binding.turnId.length > 200 || binding.conversation.length > 200
      || !Number.isSafeInteger(binding.generation) || binding.generation < 1
      || !Number.isSafeInteger(binding.inputGeneration) || binding.inputGeneration < 1
      || !Number.isSafeInteger(binding.expires) || binding.expires <= Date.now()
      || binding.expires > Date.now() + 120_000) throw new Error('Private caller refused');
    const caller = randomBytes(32).toString('hex');
    const turnId = binding.turnId;
    function close() { remove(turnId); }
    const timer = setTimeout(close, binding.expires - Date.now());
    timer.unref();
    const entry: Caller = { ...binding, digest: digest(`Bearer ${caller}`), timer };
    used.add(turnId);
    active.set(turnId, entry);
    function bind(thread: string) {
      if (live(turnId) !== entry || !thread || thread.length > 200
        || (entry.thread !== undefined && entry.thread !== thread)) {
        throw new Error('Private caller refused');
      }
      for (const other of active.values()) {
        if (other !== entry && other.thread === thread) throw new Error('Private caller refused');
      }
      entry.thread = thread;
    }
    return { caller, bind, close };
  }

  function identify(authorization: string) {
    const supplied = digest(authorization);
    for (const entry of active.values()) {
      if (entry.digest === supplied && live(entry.turnId)) return entry.turnId;
    }
    return undefined;
  }

  function permits(callerTurn: string | undefined, turnId: string, thread?: string) {
    if (!callerTurn) return !used.has(turnId);
    const entry = live(turnId);
    return callerTurn === turnId && entry !== undefined
      && (thread === undefined || entry.thread === thread);
  }

  function check(input: Record<string, unknown>) {
    const turnId = String(input['turnId']);
    const entry = live(turnId);
    if (used.has(turnId) && !entry) throw new Error('Private caller refused');
    for (const other of active.values()) {
      if (other.thread && other.thread === input['thread'] && other.turnId !== turnId) {
        throw new Error('Private caller refused');
      }
    }
    if (!entry) return false;
    if (entry.conversation !== input['conversation'] || entry.generation !== input['generation']
      || entry.inputGeneration !== input['inputGeneration']
      || entry.thread !== input['thread']) throw new Error('Private caller refused');
    return true;
  }

  function close() {
    for (const turnId of active.keys()) remove(turnId);
  }
  return { register, identify, permits, check, remove, close };
}
