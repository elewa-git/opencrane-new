// S0.5's desktop, with ephemeral passwords and the same trusted UID boundary.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
if (!process.setgroups || !process.setgid || !process.setuid) throw new Error('Linux required');
process.setgroups([]); process.setgid(1002); process.setuid(1002);
mkdirSync('/tmp/.X11-unix', { recursive: true }); chmodSync('/tmp/.X11-unix', 0o1777);
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
