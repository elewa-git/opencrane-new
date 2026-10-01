// Keep credentials in ephemeral homes; only session files, work and browser data persist.
import { mkdirSync, chownSync, symlinkSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
for (const [name, uid] of [['codex', 1000], ['workspace', 1001], ['profile', 1002]]) {
  const path = `/home/agent/${name}`;
  mkdirSync(path, { recursive: true, mode: name === 'workspace' ? 0o755 : 0o700 }); chownSync(path, uid, uid);
}
rmSync('/workspace', { recursive: true }); symlinkSync('/home/agent/workspace', '/workspace');
symlinkSync('/home/agent/codex', '/home/codex/.codex');
// S0.1b's supervisor, executor and authenticated model proxy are unchanged.
spawn('node', ['/spike/computer.mjs'], { stdio: 'inherit' });
