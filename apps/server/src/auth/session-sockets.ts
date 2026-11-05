import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import type { WebSocket } from 'ws';

const servers = new WeakMap<Server, Map<string, Set<WebSocket>>>();

function cookieDigest(cookie: string): string {
  const hash = createHash('sha256');
  hash.update(cookie);
  return hash.digest('hex');
}

export function trackSessionSocket(server: Server, cookie: string, socket: WebSocket): void {
  let sessions = servers.get(server);
  if (!sessions) {
    sessions = new Map();
    servers.set(server, sessions);
  }
  const digest = cookieDigest(cookie);
  let sockets = sessions.get(digest);
  if (!sockets) {
    sockets = new Set();
    sessions.set(digest, sockets);
  }
  const activeSessions = sessions;
  const activeSockets = sockets;
  activeSockets.add(socket);
  function remove(): void {
    activeSockets.delete(socket);
    if (activeSockets.size === 0) activeSessions.delete(digest);
  }
  socket.once('close', remove);
}

export function closeSessionSockets(server: Server, cookie: string): void {
  const sessions = servers.get(server);
  const digest = cookieDigest(cookie);
  const sockets = sessions?.get(digest);
  if (!sockets) return;
  for (const socket of sockets) {
    // Stop delivery synchronously, before the browser receives the close event.
    socket.close(1008, 'signed out');
  }
}
