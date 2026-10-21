import { readFile } from 'node:fs/promises';
import { encodeSession, loadAuthConfig } from '@opencrane/auth';
import { demoStackId, seedDemo } from './demo-seed.ts';
import { requireOwnerRun } from './owner-run.ts';

try {
  const ownerRun = process.argv.length === 3 && process.argv[2] === '--owner-run';
  if (process.env['DEV_STACK_ID'] === 'owner') {
    requireOwnerRun(ownerRun);
  }
  const id = demoStackId(process.env['DEV_STACK_ID'], ownerRun);
  if (process.argv.length > 2 && !ownerRun) {
    throw new Error('Invalid arguments');
  }
  // Check the id before importing settings, which otherwise default to the owner's directory.
  const { authEnv, directory, readEnv, root } = await import('./config.ts');
  const marker = await readFile(`${directory}/stack-owner`, 'utf8');
  let recordedRoot = marker;
  if (marker.startsWith('worktree=')) {
    const markerLines = marker.split('\n');
    const firstLine = markerLines[0]!;
    recordedRoot = firstLine.slice('worktree='.length);
  }
  if (recordedRoot !== root) {
    throw new Error('Foreign stack');
  }
  const settings = await readEnv('settings');
  const authSettings = await authEnv();
  const config = loadAuthConfig(authSettings);
  const contents = await readFile(`${root}/infra/dev-stack/zitadel.json`, 'utf8');
  const oidc = JSON.parse(contents) as { extraIdentities: Array<{ subject: string }> };
  const now = Math.floor(Date.now() / 1000);
  // Use the existing short-lived development Owner session; product APIs still check authority.
  const session = {
    sub: oidc.extraIdentities[0]!.subject,
    orgId: config.expectedOrgId!,
    roles: [],
    authTime: now,
    exp: now + 300,
  };
  const cookie = `${config.cookieName}=${encodeSession(config, session)}`;
  const origin = settings['ORIGIN']!;
  if (id !== 'owner' && origin !== `http://127.0.0.1:${25000 + Number(id) * 100 + 6}`) {
    throw new Error('Unexpected origin');
  }
  const options = { origin, cookie, directory };
  await seedDemo(options);
  console.log('PASS demo groups and assistant saved; computer readiness is not checked');
  const bookmarks = ['/workspace', '/workspace/direct', '/workspace/shared',
    '/org/people?tab=groups', '/org/people/groups/demo-acacia',
    '/org/people/groups/demo-kijani', '/org/models', '/org/spending', '/org/history'];
  for (const path of bookmarks) {
    console.log(`${origin}${path}`);
  }
} catch {
  console.error('Demo seed incomplete. Re-run to read original receipts; do not remove request records.');
  process.exitCode = 1;
}
