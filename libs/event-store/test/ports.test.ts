import { once } from 'node:events';
import { connect, createServer, type Server } from 'node:net';
import { expect, it } from 'vitest';
import { reservePort } from './ports.ts';

async function listen(listener: Server, port: number) {
  const listening = once(listener, 'listening');
  listener.listen(port, '127.0.0.1');
  await listening;
}

async function closeListener(listener: Server) {
  if (!listener.listening) {
    return;
  }
  const closed = once(listener, 'close');
  listener.close();
  await closed;
}

async function holdsPortUntilRelease() {
  const reservation = await reservePort();
  const contender = createServer();
  try {
    await expect(listen(contender, reservation.port)).rejects.toMatchObject({ code: 'EADDRINUSE' });
    const probe = connect(reservation.port, '127.0.0.1');
    await once(probe, 'close');
    await reservation.release();
    await expect(listen(contender, reservation.port)).resolves.toBeUndefined();
  } finally {
    await closeListener(contender);
    await reservation.release();
  }
}
it('keeps a chosen port bound until the peer is ready to start', holdsPortUntilRelease);
