const APPROVAL_WAIT_LIMIT_MS = 15 * 60_000;
const STOPPED = 'This turn was stopped. Nothing was sent.';
interface Hold {
  approvalId: string;
  thread: string;
  send(): Promise<void>;
  answer(text: string): void;
}
interface Group {
  expiresAt: number;
  first: Hold;
  followers: Hold[];
  timer: NodeJS.Timeout;
  sending: boolean;
  finishing: boolean;
  ended: boolean;
}
interface ApprovalDriver {
  waiting(thread: string, approvalId: string): boolean;
  renew(thread: string): Promise<void>;
}

export function approvalHolds(driver: ApprovalDriver, limit = APPROVAL_WAIT_LIMIT_MS) {
  const groups = new Map<string, Group>();
  let supported = false;
  let stopped = false;

  function answer(group: Group, text: string) {
    group.first.answer(text);
    for (const follower of group.followers) follower.answer(text);
    group.followers = [];
  }

  function end(group: Group, text: string) {
    group.ended = true;
    clearTimeout(group.timer);
    const reply = group.sending
      ? 'The tool may have received this action. OpenCrane will not send it again.' : text;
    answer(group, reply);
  }

  async function settle(approvalId: string, state: string) {
    const group = groups.get(approvalId);
    if (!group || group.finishing || group.ended) return;
    // Claim the wake before renewal. Reconnects and duplicate signals cannot send twice.
    group.finishing = true;
    clearTimeout(group.timer);
    try {
      await driver.renew(group.first.thread);
      if (group.ended || !supported) return;
      if (state === 'approved') {
        group.sending = true;
        await group.first.send();
        for (const follower of group.followers) {
          follower.answer('This action was already answered. OpenCrane will not send it again.');
        }
        group.followers = [];
      } else {
        answer(group, refusalMessage(state));
      }
    } catch {
      if (!group.ended) answer(group, 'The turn could not get a new pass. Nothing was sent.');
    }
    group.ended = true;
  }

  function add(hold: Hold) {
    if (stopped) {
      hold.answer(STOPPED);
      return;
    }
    if (!supported) {
      hold.answer('This server cannot wait for approval. Nothing was sent.');
      return;
    }
    const previous = groups.get(hold.approvalId);
    if (previous) {
      if (previous.first.thread !== hold.thread || previous.ended || previous.finishing) {
        hold.answer('This action was already answered. Nothing was sent again.');
      } else previous.followers.push(hold);
      return;
    }
    function expired() { void settle(hold.approvalId, 'timeout'); }
    const timer = setTimeout(expired, limit);
    timer.unref();
    const group: Group = {
      expiresAt: Date.now() + limit,
      first: hold,
      followers: [],
      timer,
      sending: false,
      finishing: false,
      ended: false,
    };
    groups.set(hold.approvalId, group);
    if (!driver.waiting(hold.thread, hold.approvalId)) end(group, STOPPED);
  }

  function stop() {
    stopped = true;
    for (const [approvalId, group] of groups) {
      // Keep an action already being sent on its original answer path.
      if (group.sending) continue;
      if (!group.ended) end(group, STOPPED);
      groups.delete(approvalId);
    }
  }

  function heldCount() {
    let count = 0;
    for (const group of groups.values()) {
      if (!group.ended) count++;
    }
    return count;
  }

  function endThread(thread: string) {
    for (const [approvalId, group] of groups) {
      if (group.first.thread !== thread) continue;
      if (stopped && group.sending) continue;
      end(group, STOPPED);
      groups.delete(approvalId);
    }
  }

  function resume(value: boolean) {
    if (stopped) return;
    supported = value;
    for (const group of groups.values()) {
      if (group.ended) continue;
      if (!supported) end(group, 'This server cannot wait for approval. Nothing was sent.');
      else if (!group.finishing) driver.waiting(group.first.thread, group.first.approvalId);
    }
  }

  function until(thread: string) {
    let deadline = 0;
    for (const group of groups.values()) {
      if (group.first.thread === thread && !group.ended) {
        deadline = Math.max(deadline, group.expiresAt + 10_000);
      }
    }
    return deadline;
  }

  return { add, settle, endThread, resume, until, stop, get size() { return heldCount(); } };
}

function refusalMessage(state: string) {
  switch (state) {
    case 'denied':
      return 'The requester denied this action. Nothing was sent.';
    case 'expired':
      return 'The approval expired. Nothing was sent.';
    case 'cancelled':
      return 'The approval was cancelled. Nothing was sent.';
    case 'outcome_unknown':
      return 'The approval was already used; the tool may have received this action.';
    case 'timeout':
      return 'No decision arrived in time. Nothing was sent.';
    default:
      return 'This action was not approved. Nothing was sent.';
  }
}
