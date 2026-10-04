/// <reference lib="dom" />
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import type { Page } from 'playwright';
import { z } from 'zod';
import type { EventStore } from '@opencrane/event-store';
import { grantStream } from '@opencrane/authz';
import { history } from '@opencrane/models';
import { directory } from './config.ts';
import { namespace, secondary, stackId } from './identity.ts';

/** The deployed requester controls the real desktop while another participant watches. */
export async function browserTakeoverJourney(page: Page, participant: Page, origin: string,
  computer: { assistant_id: string; computer_id: string; generation: number }, input: {
    member: string; admin: string; silo: string; store: EventStore; run: 'fresh' | 'repeat';
    append: (type: string, subject: string, data: Record<string, unknown>) => Promise<void>;
    until: (check: () => Promise<boolean> | boolean, label: string) => Promise<void>;
    desktopAllowed: (memberId: string) => Promise<boolean>;
  }) {
  assert(secondary, 'Takeover qualification only uses a claimed secondary stack');
  const { member, admin, silo, store, append, until, run } = input;
  const conversation = new URL(page.url()).searchParams.get('conversation');
  assert(conversation);
  const width = page.viewportSize()!.width;
  await participant.setViewportSize({ width, height: 900 });
  const rows = async () => (await history(store, `computer-${computer.assistant_id}`, silo)).map(row => ({
    ...row, event: { ...row.event, data: z.record(z.string(), z.unknown()).parse(row.event.data) },
  }));
  const output = 'docs/process/p3-17-live';
  await mkdir(output, { recursive: true });
  const kube = async (...args: string[]) => (await promisify(execFile)('kubectl', [
    '--kubeconfig', `${directory}/computer-kubeconfig.json`, '-n', namespace,
    'exec', computer.computer_id, '-c', 'computer', '--', ...args,
  ], { timeout: 10_000 })).stdout.trim();
  const post = async (path: string, data: unknown) => {
    const response = await page.request.post(`${origin}${path}`, { headers: { origin }, data });
    assert.equal(response.status(), 200, path);
  };
  for (const granteeId of [member, admin]) await append('grant.given', grantStream('shared_desktop', computer.computer_id), {
    resourceType: 'shared_desktop', resourceId: computer.computer_id, granteeId, granteeKind: 'member', grantedBy: admin,
  });
  await append('participant.added', `conversation-${conversation}`, { conversationId: conversation, participantId: admin, addedBy: member });
  await until(async () => (await Promise.all([member, admin].map(input.desktopAllowed))).every(Boolean), 'both desktop grants projected');
  const other = randomUUID();
  await post('/api/conversations', { id: randomUUID(), conversationId: other, assistantId: computer.assistant_id });
  await until(async () => (await page.request.get(`${origin}/api/conversations/${other}/messages`)).ok(), 'second conversation projected');
  const start = async () => {
    const turns = [randomUUID(), randomUUID()];
    for (const [index, conversationId] of [conversation, other].entries()) await post(`/api/conversations/${conversationId}/messages`, {
      id: turns[index], text: 'Say hello again.',
    });
    await until(async () => {
      const audit = await rows();
      return turns.every(turn => audit.some(row => row.event.type === 'computer.turn_started' && row.event.data['turnId'] === turn));
    }, 'two running Codex threads');
    return turns;
  };
  const viewer = page.getByRole('dialog', { name: 'Computer view', exact: true });
  const open = async (target: Page) => {
    await target.goto(`${origin}/workspace?conversation=${conversation}`);
    if (target.viewportSize()!.width === 390) await target.getByRole('button', { name: 'Session panel', exact: true }).click();
    await target.getByRole('button', { name: 'Watch your computer', exact: true }).click();
    await target.getByText('Viewing', { exact: true }).waitFor();
  };
  await until(async () => (await participant.request.get(`${origin}/api/conversations/${conversation}/messages`)).ok(), 'second participant projected');
  const readonly = participant.getByRole('dialog', { name: 'Computer view', exact: true });
  await open(page);
  const take = async (turns: string[]) => {
    await viewer.getByRole('button', { name: 'Take control', exact: true }).press('Enter');
    await viewer.getByText('You are in control', { exact: true }).waitFor();
    const audit = await rows();
    const started = audit.findLast(row => row.event.type === 'takeover.started')!;
    assert.deepEqual((started.event.data['affectedTurns'] as Array<{ turnId: string }>).map(turn => turn.turnId).sort(), [...turns].sort());
    const active = new Set<string>();
    for (const { event } of audit) {
      if (event.type === 'computer.turn_started') active.add(String(event.data['turnId']));
      if (event.type === 'computer.turn_closed') active.delete(String(event.data['turnId']));
    }
    assert.equal(active.size, 0, 'Every computer thread has a terminal report before writer admission');
    assert.equal(await kube('node', '--input-type=module', '-e', String.raw`import{readdirSync,readFileSync}from'node:fs';console.log(readdirSync('/proc').filter(p=>/^\d+$/.test(p)).filter(p=>{try{const s=readFileSync('/proc/'+p+'/status','utf8');return /^Uid:\s+1001\s/m.test(s)&&!/^State:\s+Z/m.test(s)}catch{return false}}).length)`), '0');
    assert.equal(await kube('cat', '/home/agent/codex/bridge-reports.jsonl.paused'), started.event.data['leaseId']);
    return started;
  };
  const resumed = async (turns: string[]) => {
    await viewer.getByText('Viewing', { exact: true }).waitFor();
    await until(async () => {
      const audit = await rows();
      return [conversation, other].every(conversationId => audit.some(row => row.event.type === 'computer.turn_started'
        && row.event.data['conversationId'] === conversationId && !turns.includes(String(row.event.data['turnId']))
        && row.sequence > audit.findLast(r => r.event.type === 'takeover.ended')!.sequence));
    }, 'Release admits fresh turns in both conversations');
    await until(async () => {
      const audit = await rows();
      return audit.filter(row => row.event.type === 'computer.turn_started').every(started => audit.some(row => row.event.type === 'computer.turn_closed' && row.event.data['turnId'] === started.event.data['turnId']));
    }, 'resumed stub turns complete');
    assert.equal(await kube('node', '-e', "console.log(require('fs').existsSync('/home/agent/codex/bridge-reports.jsonl.paused'))"), 'false');
  };
  const turns = await start();
  const lease = await take(turns);
  await open(participant);
  assert.equal((await participant.request.post(`${origin}/api/conversations/${conversation}/control`, {
    headers: { origin, 'x-opencrane-view': '1' }, data: { action: 'start' },
  })).status(), 403, 'Second participant cannot become the requester');
  assert.equal(await readonly.getByRole('button', { name: 'Take control', exact: true }).count(), 0);
  await kube('sh', '-c', 'DISPLAY=:1 xev -geometry 800x600+0+0 > /tmp/p317-input.log 2>&1 &');
  await kube('sh', '-c', 'DISPLAY=:1 xdotool search --sync --name "Event Tester" windowraise windowfocus');
  const canvas = viewer.locator('canvas');
  await viewer.getByRole('button', { name: 'Use desktop keyboard', exact: true }).press('Enter');
  await canvas.scrollIntoViewIfNeeded();
  await page.keyboard.press('a');
  await until(async () => (await kube('cat', '/tmp/p317-input.log')).includes('keysym 0x61, a'), 'browser keyboard reaches X desktop');
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3);
  await until(async () => /x:(?:399|400|401) y:(?:199|200|201)/u.test(await kube('env', 'DISPLAY=:1', 'xdotool', 'getmouselocation')), 'browser pointer reaches X desktop');
  const location = await kube('env', 'DISPLAY=:1', 'xdotool', 'getmouselocation');
  await readonly.locator('canvas').click(); await participant.keyboard.press('b');
  await delay(200);
  assert(!(await kube('cat', '/tmp/p317-input.log')).includes('keysym 0x62, b'), 'Read-only participant sends no keyboard input');
  assert.equal(await kube('env', 'DISPLAY=:1', 'xdotool', 'getmouselocation'), location, 'Read-only pointer cannot move desktop cursor');
  await page.screenshot({ path: `${output}/${run}-control-${width}.png`, fullPage: true });
  await participant.screenshot({ path: `${output}/${run}-participant-${width}.png`, fullPage: true });
  await page.keyboard.press('F8');
  const release = viewer.getByRole('button', { name: 'Release', exact: true });
  assert(await release.evaluate(node => node === document.activeElement), 'F8 reaches Release');
  assert(!(await kube('cat', '/tmp/p317-input.log')).includes('keysym 0xffc5, F8'), 'F8 stays outside the desktop');
  await page.keyboard.press('Enter'); await resumed(turns);
  const expiringTurns = await start();
  const expiring = await take(expiringTurns);
  // View sessions also last two minutes; reopen after the writer starts its expiry clock.
  await participant.keyboard.press('Escape'); await open(participant);
  await viewer.getByText('Agent paused', { exact: true }).waitFor({ timeout: 130_000 });
  await until(async () => (await rows()).some(row => row.event.type === 'takeover.ended' && row.event.data['leaseId'] === expiring.event.data['leaseId'] && row.event.data['reason'] === 'expired'), 'expiry audited');
  assert.equal(await viewer.locator('canvas').count(), 0, 'Expiry closes writer and clears pixels');
  assert.equal(await kube('cat', '/home/agent/codex/bridge-reports.jsonl.paused'), expiring.event.data['leaseId']);
  const count = (await rows()).filter(row => row.event.type === 'computer.turn_started').length;
  await delay(2000);
  assert.equal((await rows()).filter(row => row.event.type === 'computer.turn_started').length, count, 'Expiry leaves all agent work paused');
  assert(await readonly.getByText('Viewing', { exact: true }).isVisible(), 'Second participant stays view-only through expiry');
  await page.screenshot({ path: `${output}/${run}-expired-${width}.png`, fullPage: true });
  await release.press('Enter'); await resumed(expiringTurns);
  await page.keyboard.press('Escape'); await participant.keyboard.press('Escape');
  await kube('sh', '-c', 'DISPLAY=:1 xdotool search --name "Event Tester" windowkill');
  await writeFile(`${output}/${run}-${width}.json`, JSON.stringify({ status: 'PASS', date: new Date().toISOString(), stackId, namespace,
    width, conversation, other, computer, turns, expiringTurns, pointer: location, key: 'a', expiresAt: expiring.event.data['expiresAt'], leaseId: lease.event.data['leaseId'], expiredLeaseId: expiring.event.data['leaseId'],
    checks: ['two Codex threads paused', 'no UID 1001 executor', 'X keyboard and pointer', 'F8', 'Release resumes fresh turns', 'participant view-only', 'real two-minute expiry leaves agent paused'],
  }, null, 2) + '\n');
  console.log(`PASS ${run} takeover ${width}px: requester pauses every thread, desktop input, F8/Release, second participant view-only and real lease expiry leaves agent paused`);
}
