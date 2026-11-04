import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Socket } from 'node:net';

export function launchLine(socket: Socket): Promise<string> {
  return new Promise(read);
  function read(resolve: (value: string) => void, reject: (error: Error) => void) {
    let bytes = '';
    const timer = setTimeout(failed, 5000);
    function cleanup() {
      clearTimeout(timer);
      socket.off('data', received);
      socket.off('close', failed);
      socket.off('error', failed);
      socket.pause();
    }
    function failed() {
      cleanup();
      socket.destroy();
      reject(new Error('Private launch refused'));
    }
    function received(chunk: Buffer) {
      bytes += chunk.toString('ascii');
      if (bytes.length > 256) {
        failed();
        return;
      }
      if (!bytes.includes('\n')) return;
      if (!bytes.endsWith('\n') || bytes.indexOf('\n') !== bytes.length - 1) {
        failed();
        return;
      }
      cleanup();
      resolve(bytes.slice(0, -1));
    }
    socket.on('data', received);
    socket.once('close', failed);
    socket.once('error', failed);
    socket.resume();
  }
}

function proof(key: string, challenge: string, caller: string) {
  const mac = createHmac('sha256', key);
  mac.update(`${challenge}:${caller}`);
  return mac.digest('hex');
}

export async function acceptPrivateLaunch(socket: Socket, key: string) {
  const challenge = randomBytes(32).toString('hex');
  socket.write(`${challenge}\n`);
  const reply = await launchLine(socket);
  if (!/^[a-f0-9]{64}:[a-f0-9]{64}$/u.test(reply)) throw new Error('Private launch refused');
  const caller = reply.slice(0, 64);
  const expected = Buffer.from(proof(key, challenge, caller));
  if (!timingSafeEqual(Buffer.from(reply.slice(65)), expected)) {
    throw new Error('Private launch refused');
  }
  socket.write('ok\n');
  return caller;
}

export async function requestPrivateLaunch(socket: Socket, key: string, caller: string) {
  const challenge = await launchLine(socket);
  if (!/^[a-f0-9]{64}$/u.test(challenge)) throw new Error('Private launch refused');
  socket.write(`${caller}:${proof(key, challenge, caller)}\n`);
  if (await launchLine(socket) !== 'ok') throw new Error('Private launch refused');
}
