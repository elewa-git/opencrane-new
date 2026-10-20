import { expect, it, vi } from 'vitest';
import { fixture } from './fixture.ts';

async function admitsAfterNativeRefusal() {
  const test = await fixture();
  try {
    const read = test.nats.store.readStream.bind(test.nats.store);
    let injected = false;
    async function* appendDuringAccess(...args: Parameters<typeof read>) {
      yield* read(...args);
      if (args[0] !== 'member-alice' || injected) return;
      injected = true;
      await test.append('conversation-conversation', 'agent.native_request_refused', {
        conversationId: 'conversation', turnId: 'turn', nativeRequestId: '19',
        requestKind: 'shell', outcome: 'declined',
      });
    }
    vi.spyOn(test.nats.store, 'readStream').mockImplementation(appendDuringAccess);
    const response = await test.call();
    expect(injected).toBe(true);
    expect(response.status, response.text).toBe(200);
    expect(test.received()).toBe(1);
  } finally { vi.restoreAllMocks(); await test.close(); }
}
it('keeps decision access after a native refusal without an IAM receipt',
  admitsAfterNativeRefusal, 60_000);
