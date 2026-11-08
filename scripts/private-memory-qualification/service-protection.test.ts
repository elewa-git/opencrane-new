import { createServer } from 'node:net';
import { expect, it, vi } from 'vitest';
import { runnerProtected } from './runner-protection.ts';
import { startServiceProtection, type ServiceRole } from './service-protection.ts';

vi.mock('node:net', { spy: true });
vi.mock('./runner-protection.ts', { spy: true });

async function closesOnlyTheClientThatDisconnectsEarly(role: ServiceRole): Promise<void> {
  vi.mocked(runnerProtected).mockReturnValue(true);
  const actual = await vi.importActual<typeof import('node:net')>('node:net');
  vi.mocked(createServer).mockImplementation(actual.createServer);
  await startServiceProtection(role);
  const server: unknown = vi.mocked(createServer).mock.results.at(-1)?.value;
  if (!(server instanceof actual.Server)) {
    throw new Error('protection server did not start');
  }
  try {
    const socket = new actual.Socket();
    server.emit('connection', socket);
    const challenge = '11111111-1111-4111-8111-111111111111\n';
    socket.emit('data', Buffer.from(challenge));
    expect(() => socket.emit('error', new Error('ECONNRESET'))).not.toThrow();
    expect(socket.destroyed).toBe(true);
    expect(server.listening).toBe(true);
  } finally {
    await new Promise<void>(function close(resolve, reject) {
      server.close(function closed(error) {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}
it.each(['serverDelivery', 'bridge'] as const)(
  'keeps the %s protection service alive when a client disconnects early',
  closesOnlyTheClientThatDisconnectsEarly,
);
