import { createHash } from 'node:crypto';
import { connectionBinding, type Binding, type Registration } from './worker-request.ts';

type Owner = Pick<Binding, 'siloId' | 'computerId' | 'generation'>;
type Entry = { registration: Registration; input: string; consumed: boolean };
type State = {
  owner: Owner;
  current: Map<string, Entry>;
  seen: Map<string, string>;
  disposed: boolean;
};
const maximumBytes = 65_536;

function refuse(): never {
  throw new Error('worker_registration_refused');
}

function boundedText(value: string) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximumBytes) {
    refuse();
  }
  return value;
}

function snapshot(value: Registration, input: string, now: number): Registration {
  const registration = {
    ...connectionBinding(value),
    threadId: boundedText(value.threadId),
    toolCallId: boundedText(value.toolCallId),
    turnId: boundedText(value.turnId),
    operationId: boundedText(value.operationId),
    operationDigest: boundedText(value.operationDigest),
    host: boundedText(value.host),
    port: value.port,
    expiresAt: value.expiresAt,
  };
  if (!Number.isSafeInteger(registration.port) || registration.port < 1 ||
      registration.port > 65_535 || !Number.isSafeInteger(registration.expiresAt) ||
      registration.expiresAt <= now || !/^[a-f0-9]{64}$/u.test(registration.operationDigest)) {
    refuse();
  }
  if (typeof input !== 'string' || Buffer.byteLength(JSON.stringify(registration)) > maximumBytes ||
      Buffer.byteLength(input) > maximumBytes) {
    refuse();
  }
  return Object.freeze(registration);
}

function bindingId(binding: Binding) {
  return JSON.stringify(connectionBinding(binding));
}

function expire(state: State, now: number) {
  for (const [identity, entry] of state.current) {
    if (now >= entry.registration.expiresAt) {
      state.current.delete(identity);
    }
  }
}

function add(state: State, registration: Registration, input: string, now: number) {
  if (state.disposed || registration.siloId !== state.owner.siloId ||
      registration.computerId !== state.owner.computerId ||
      registration.generation !== state.owner.generation) {
    refuse();
  }
  const hash = createHash('sha256');
  hash.update(JSON.stringify([registration, input]));
  const fingerprint = hash.digest('hex');
  const previous = state.seen.get(registration.operationId);
  if (previous !== undefined) {
    if (previous !== fingerprint) {
      refuse();
    }
    // Keep retries harmless even after replacement, disconnection or consumption.
    return;
  }
  expire(state, now);
  const identity = bindingId(registration);
  if (!state.current.has(identity) && state.current.size >= 2) {
    refuse();
  }
  // Retain only fingerprints for old operations. Refuse saturation rather than
  // forget a previous claim and allow the same operation to acquire permission again.
  if (state.seen.size >= 1024) {
    refuse();
  }
  const entry = { registration, input, consumed: false };
  state.seen.set(registration.operationId, fingerprint);
  state.current.set(identity, entry);
}

// Create one private store for one computer generation. A new store starts empty.
// Keep these methods inside the supervisor; no command or socket exposes them.
export function workerRegistrations(owner: Owner, now = Date.now) {
  const savedOwner = { siloId: owner.siloId, computerId: owner.computerId,
    generation: owner.generation };
  Object.freeze(savedOwner);
  const state: State = { owner: savedOwner, current: new Map(), seen: new Map(), disposed: false };

  function register(value: Registration, input: string) {
    try {
      const time = now();
      const registration = snapshot(value, input, time);
      add(state, registration, input, time);
    } catch {
      refuse();
    }
  }

  function lookup(binding: Binding) {
    expire(state, now());
    const identity = bindingId(binding);
    const entry = state.current.get(identity);
    if (!entry || state.disposed) {
      return undefined;
    }
    const saved = entry;
    function consume() {
      expire(state, now());
      if (state.disposed || state.current.get(identity) !== saved || saved.consumed) {
        return false;
      }
      // Do not yield between checking the exact record and consuming it.
      saved.consumed = true;
      return true;
    }
    const handle = { registration: entry.registration, input: entry.input, consume };
    return Object.freeze(handle);
  }

  function disconnect(executorId: string) {
    for (const [identity, entry] of state.current) {
      if (entry.registration.executorId === executorId) {
        state.current.delete(identity);
      }
    }
  }

  // Retire the generation permanently; clearing records alone would allow old deliveries.
  function dispose() {
    state.disposed = true;
    state.current.clear();
    state.seen.clear();
  }

  const methods = { register, lookup, disconnect, dispose };
  return Object.freeze(methods);
}
