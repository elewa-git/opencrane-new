const processLimit = 4;
const queueLimit = 8;
const waitMs = 100;

export class MemoryBusy extends Error {}

type Write = { member: string; pair: string };
type WaitingWrite = {
  write: Write;
  result: ReturnType<typeof Promise.withResolvers<() => void>>;
  timer: ReturnType<typeof setTimeout>;
  deadline: number;
};

const activeMembers = new Set<string>();
const waitingMembers = new Set<string>();
const reservedPairs = new Set<string>();
const waitingWrites: WaitingWrite[] = [];

function canStart(write: Write) {
  return activeMembers.size < processLimit && !activeMembers.has(write.member);
}

function startWrite(write: Write) {
  activeMembers.add(write.member);
  function release() {
    activeMembers.delete(write.member);
    reservedPairs.delete(write.pair);
    startWaitingWrites();
  }
  return release;
}

function refuseWaitingWrite(waiting: WaitingWrite) {
  clearTimeout(waiting.timer);
  waitingMembers.delete(waiting.write.member);
  reservedPairs.delete(waiting.write.pair);
  waiting.result.reject(new MemoryBusy('Memory writes are busy'));
}

function startWaitingWrites() {
  for (let index = 0; index < waitingWrites.length; index++) {
    const waiting = waitingWrites[index]!;
    if (performance.now() >= waiting.deadline) {
      waitingWrites.splice(index, 1);
      index--;
      refuseWaitingWrite(waiting);
      continue;
    }
    // Leave room for another member rather than waiting behind a member already at their limit.
    if (!canStart(waiting.write)) {
      continue;
    }
    waitingWrites.splice(index, 1);
    index--;
    clearTimeout(waiting.timer);
    waitingMembers.delete(waiting.write.member);
    const release = startWrite(waiting.write);
    waiting.result.resolve(release);
  }
}

function waitForWrite(write: Write) {
  waitingMembers.add(write.member);
  const result = Promise.withResolvers<() => void>();
  function expire() {
    const index = waitingWrites.indexOf(waiting);
    if (index !== -1) {
      waitingWrites.splice(index, 1);
      refuseWaitingWrite(waiting);
    }
  }
  const timer = setTimeout(expire, waitMs);
  const waiting = { write, result, timer, deadline: performance.now() + waitMs };
  waitingWrites.push(waiting);
  return result.promise;
}

export async function acquireMemoryWrite(silo: string, memberId: string, scopeId: string) {
  const member = JSON.stringify([silo, memberId]);
  const pair = JSON.stringify([silo, memberId, scopeId]);
  const write = { member, pair };
  if (reservedPairs.has(pair)) {
    throw new MemoryBusy('This member already has a write in this scope');
  }
  if (waitingMembers.has(member)) {
    throw new MemoryBusy('This member already has a waiting write');
  }
  if (canStart(write)) {
    reservedPairs.add(pair);
    return startWrite(write);
  }
  if (waitingWrites.length >= queueLimit) {
    throw new MemoryBusy('Memory writes are busy');
  }
  // Keep both limits across scopes so one member cannot fill the shared queue.
  reservedPairs.add(pair);
  return waitForWrite(write);
}
