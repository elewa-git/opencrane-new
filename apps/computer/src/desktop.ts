// Run the desktop with temporary passwords under its own trusted user ID.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import {
  prepareDisplaySocketDirectory, removeStaleDisplayLock, restrictDisplaySocketDirectory,
} from './display-lock.ts';

// Clear a lock left in disk-backed /tmp when this container restarts in its Pod.
removeStaleDisplayLock('/tmp/.X1-lock', '/proc', 1002);

if (!process.setgroups || !process.setgid || !process.setuid) throw new Error('Linux required');
process.setgroups([]); process.setgid(1002); process.setuid(1002);
prepareDisplaySocketDirectory('/tmp/.X11-unix');
process.env['HOME'] = '/home/desktop';
mkdirSync('/home/desktop/.vnc', { recursive: true, mode: 0o700 });
const passwords = Object.fromEntries(['viewer', 'requester'].map(name => [name, randomBytes(24).toString('hex')]));
for (const [name, password] of Object.entries(passwords)) {
  execFileSync('kasmvncpasswd', ['-u', name, ...(name === 'viewer' ? ['-r'] : ['-r', '-w'])], { input: `${password}\n${password}\n` });
}
writeFileSync('/home/desktop/credentials.json', JSON.stringify(passwords), { mode: 0o600 });
const child = spawn('Xvnc', [':1', '-geometry', '800x600', '-depth', '24', '-interface', '0.0.0.0',
  '-websocketPort', '6901', '-httpd', '/usr/share/kasmvnc/www', '-disableBasicAuth', '0',
  '-KasmPasswordFile', '/home/desktop/.kasmpasswd', '-SecurityTypes', 'None',
  '-publicIP', '127.0.0.1', '-sslOnly', '0', '-localhost', '0', '-AcceptKeyEvents', '1', '-AcceptPointerEvents', '1',
  '-AlwaysShared', '-ac', '-Log', '*:stdout:30'], { stdio: 'inherit' });
child.on('error', () => process.exit(1));
child.on('exit', () => process.exit(1));
process.on('SIGTERM', () => child.kill('SIGTERM'));

function wait(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function protectDisplaySocketDirectory(): Promise<void> {
  const socketPath = '/tmp/.X11-unix/X1';
  const deadline = Date.now() + 5000;
  while (!existsSync(socketPath)) {
    if (Date.now() >= deadline) throw new Error('Xvnc did not create its display socket');
    await wait(50);
  }
  restrictDisplaySocketDirectory('/tmp/.X11-unix');
  const permissionTimer = setInterval(restoreDisplaySocketPermissions, 250);
  permissionTimer.unref();
}

function restoreDisplaySocketPermissions(): void {
  restrictDisplaySocketDirectory('/tmp/.X11-unix');
}

protectDisplaySocketDirectory().catch(stopDisplayServer);

function stopDisplayServer(): void {
  child.kill('SIGTERM');
  process.exit(1);
}
