import type { Page } from 'playwright';

export type ReplyOperation = { method: string; url: string; status: number };
type ReplyTransport = 'page' | 'direct';

export type ExpectedReply = {
  transport: ReplyTransport;
  method: string;
  path: RegExp;
  label: string;
  minimum?: number;
};

export type ExpectedBrowserReplies = ReadonlyMap<Page, readonly ExpectedReply[]>;

export class ReplyCoverageFailure extends Error {}

function operationKey({ method, url, status }: ReplyOperation): string {
  return `${method} ${url} ${status}`;
}

function addReply(counts: Map<string, number>, reply: ReplyOperation): void {
  const key = operationKey(reply);
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

type InspectedReply = ReplyOperation & { transport: ReplyTransport };

export class ReplyCoverage {
  private readonly delivered = new Map<string, number>();
  private readonly inspectedPageReplies = new Map<string, number>();
  private readonly inspected: InspectedReply[] = [];

  recordDelivery(reply: ReplyOperation): void {
    addReply(this.delivered, reply);
  }

  recordInspection(reply: ReplyOperation, transport: ReplyTransport): void {
    this.inspected.push({ ...reply, transport });
    if (transport === 'page') {
      addReply(this.inspectedPageReplies, reply);
    }
  }

  checkDeliveries(): void {
    for (const [key, delivered] of this.delivered) {
      if (this.inspectedPageReplies.get(key) !== delivered) {
        throw new ReplyCoverageFailure('A delivered API reply was not inspected.');
      }
    }
  }

  checkOperations(operations: readonly ExpectedReply[]): void {
    for (const expected of operations) {
      function matches(reply: InspectedReply): boolean {
        if (reply.transport !== expected.transport || reply.method !== expected.method ||
            reply.status < 200 || reply.status >= 300) {
          return false;
        }
        const path = new URL(reply.url).pathname;
        return expected.path.test(path);
      }
      const matching = this.inspected.filter(matches);
      if (matching.length < (expected.minimum ?? 1)) {
        throw new ReplyCoverageFailure(`Missing inspected replies for ${expected.label}.`);
      }
    }
  }
}
