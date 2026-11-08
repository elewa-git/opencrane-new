import { EventEmitter } from 'node:events';
import { createServer, type Server, type Socket } from 'node:net';
import { expect, it, vi } from 'vitest';
import { runnerProtected } from './runner-protection.ts';
import { startServiceProtection } from './service-protection.ts';

vi.mock('node:net', { spy: true });
vi.mock('./runner-protection.ts', { spy: true });

async function closesOnlyTheClientThatDisconnectsEarly(): Promise<void> {
  vi.mocked(runnerProtected).mockReturnValue(true);
  const server = Object.assign(new EventEmitter(), {
    listen(_address: string, ready: () => void): void {
      ready();
    },
  }) as Server;
  vi.mocked(createServer).mockReturnValue(server);
  await startServiceProtection('serverDelivery');
  const accepted = vi.mocked(createServer).mock.calls[0]?.[0];
  expect(accepted).toBeTypeOf('function');
  const socket = Object.assign(new EventEmitter(), {
    destroy: vi.fn(),
    setTimeout: vi.fn(),
  }) as Socket;
  accepted?.(socket);
  expect(() => socket.emit('error', new Error('ECONNRESET'))).not.toThrow();
  expect(socket.destroy).toHaveBeenCalled();
}
it('keeps the protection service alive when an accepted client disconnects early',
  closesOnlyTheClientThatDisconnectsEarly);
