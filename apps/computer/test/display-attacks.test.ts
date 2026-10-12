import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { it } from 'vitest';

function attack(scenario: string) {
  const args = ['run', '--rm', '--network', 'none', '--cap-drop=ALL',
    '--cap-add=SETUID', '--cap-add=SETGID', '--cap-add=CHOWN', '--cap-add=DAC_OVERRIDE',
    '-v', `${resolve('apps/computer')}:/display:ro`, '--entrypoint', 'node',
    'ocn-upload-computer:test', '--experimental-strip-types',
    '/display/test/display-attacks.mjs', scenario];
  execFileSync('docker', args, { encoding: 'utf8', timeout: 20000 });
}

function refusesSocketSwap() { attack('socket-swap'); }
function refusesSymlinkLock() { attack('symlink-lock'); }
function refusesForeignLock() { attack('foreign-lock'); }
function preventsLockReplacement() { attack('lock-replacement'); }

it('prevents the agent making desktop credentials readable through an X11 symlink', refusesSocketSwap);
it('refuses a display lock symlink made by the agent', refusesSymlinkLock);
it('refuses a display lock owned by the agent', refusesForeignLock);
it('prevents agent replacement between checking and unlinking a display lock', preventsLockReplacement);
