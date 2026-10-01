import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
mkdirSync('/tmp/.X11-unix', { recursive: true }); chmodSync('/tmp/.X11-unix', 0o1777);
process.setgroups([]); process.setgid(1002); process.setuid(1002);
process.env.HOME = '/home/desktop';
mkdirSync('/home/desktop/.vnc', { recursive: true, mode: 0o700 });
const passwords = Object.fromEntries(['viewer', 'requester'].map(name => [name, randomBytes(24).toString('hex')]));
for (const [name, password] of Object.entries(passwords)) {
  execFileSync('kasmvncpasswd', ['-u', name, ...(name === 'viewer' ? ['-r'] : ['-r', '-w'])], { input: `${password}\n${password}\n` });
}
// The test supervisor reads this private, ephemeral file and installs it in its gateway.
writeFileSync('/home/desktop/credentials.json', JSON.stringify(passwords), { mode: 0o600 });
spawn('Xvnc', [':1', '-geometry', '800x600', '-depth', '24', '-interface', '0.0.0.0',
  '-websocketPort', '6901', '-httpd', '/usr/share/kasmvnc/www', '-disableBasicAuth', '0',
  '-KasmPasswordFile', '/home/desktop/.kasmpasswd', '-SecurityTypes', 'None',
  '-publicIP', '127.0.0.1', '-sslOnly', '0', '-localhost', '0', '-AcceptKeyEvents', '1', '-AcceptPointerEvents', '1',
  '-AlwaysShared', '-ac', '-Log', '*:stdout:30'], { stdio: 'inherit' });
