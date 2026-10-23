import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { chromium, type Page } from 'playwright';
import { checkChangeHistory } from './demo-rehearsal-checks.ts';
import { demoRehearsal } from './demo-rehearsal.ts';
import { demoBrowser } from './demo-browser.ts';
import { RehearsalPage } from './test/rehearsal-page.ts';

type Step = { step: number; width: number; result: string; pictures: string[] };

async function repeatsBothWidthsWithoutCollisions() {
  const directory = await mkdtemp(join(tmpdir(), 'rehearsal-repeat-'));
  const owner = new RehearsalPage();
  const member = new RehearsalPage();
  owner.refusalMissing = false;
  member.refusalMissing = false;
  const options = { origin: 'https://rehearsal.example.invalid', cookie: '', directory };
  const budget = { sequence: 1, defaultPayingGroupId: null, periodStart: null,
    todayCents: 10, monthCents: 10, reservedCents: 0, ceilingCents: 1000,
    dailyCeilingCents: 700, ceilings: [] };
  const restoreIds = new Set<string>();
  async function fetchFixture(address: string, init?: RequestInit) {
    const url = new URL(address);
    if (url.pathname.startsWith('/api/org/models/changes/')) {
      const commandId = url.pathname.slice('/api/org/models/changes/'.length);
      if (restoreIds.has(commandId)) {
        return Response.json({ status: 'appended' });
      }
      return Response.json({}, { status: 404 });
    }
    assert.equal(url.pathname, '/api/org/models');
    if (init?.method === 'POST') {
      const data = JSON.parse(String(init.body)) as {
        commandId: string; ceilingCents: number; dailyCeilingCents: number;
      };
      assert(!restoreIds.has(data.commandId), 'Restore commands must be unique');
      restoreIds.add(data.commandId);
      assert.equal(data.ceilingCents, budget.ceilingCents);
      assert.equal(data.dailyCeilingCents, budget.dailyCeilingCents);
      owner.limited = false;
    }
    const current = { ...budget };
    if (owner.limited) {
      current.dailyCeilingCents = budget.todayCents;
    }
    return Response.json({ budget: current });
  }
  function sanitise(value: string) {
    return value;
  }
  const network = mock.method(globalThis, 'fetch', fetchFixture);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const passed = await demoRehearsal(owner as unknown as Page, member as unknown as Page,
        options, directory, 1000, sanitise);
      const receipt = await readFile(`${directory}/results.json`, 'utf8');
      assert.equal(passed, true, receipt);
      const steps = JSON.parse(receipt) as Step[];
      assert.equal(steps.length, 20);
      for (const step of steps) {
        assert.equal(step.result, 'PASS');
        assert(step.pictures.length > 0, 'Every PASS names its saved pictures');
        for (const path of step.pictures) {
          assert.equal(await readFile(path, 'utf8'), 'Synthetic picture fixture');
        }
      }
      assert.equal(owner.limited, false, 'Restore both limits before another width or attempt');
    }
    assert.equal(owner.invitationEmails.size, 4);
    assert.equal(restoreIds.size, 4);
    const identities = new Set<string>();
    for (const email of owner.invitationEmails) {
      assert.match(email, /^rehearsal-[a-f0-9-]+-(1280|390)@example\.invalid$/u);
      const identity = email.slice('rehearsal-'.length, email.indexOf('@'));
      identities.add(identity);
    }
    for (const page of [owner, member]) {
      for (const entry of page.enteredValues) {
        if (entry.selector !== '#message' && entry.selector !== 'Message your agent') {
          continue;
        }
        let matched = false;
        for (const identity of identities) {
          if (entry.value.includes(identity)) {
            matched = true;
          }
        }
        assert(matched, 'Created chats and messages identify their width and attempt');
      }
    }
    for (const width of [1280, 390]) {
      for (const kind of ['limit', 'group']) {
        function isHistoryPicture(picture: { path: string }) {
          return picture.path.endsWith(`10-${kind}-history-${width}.png`);
        }
        const pictures = owner.pictures.filter(isHistoryPicture);
        assert.equal(pictures.length, 2);
        for (const picture of pictures) {
          assert(picture.historyInView.includes(kind === 'limit' ? 'budget' : 'team'),
            'Scroll the matching history row into view before saving its picture');
        }
      }
    }
  } finally {
    network.mock.restore();
    await rm(directory, { recursive: true, force: true });
  }
}
test('both widths run twice in one fixture with unique creations and pictures for every PASS',
  repeatsBothWidthsWithoutCollisions);

async function picturesShowHistoryRows() {
  const directory = await mkdtemp(join(tmpdir(), 'rehearsal-history-'));
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    const html = `<style>oc-audit { display: block; } article { padding: 20px; }</style>
      <oc-audit><h1>Change history</h1><article style="height: 1200px">Earlier call</article>
      <article>budget.ceiling_set</article><div style="height: 1200px"></div>
      <article>team.created</article></oc-audit>`;
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.setContent(html);
      const saved = new Set<string>();
      async function picture(name: string) {
        const event = name.includes('limit') ? 'budget.ceiling_set' : 'team.created';
        const row = page.getByText(event, { exact: true });
        const bounds = await row.boundingBox();
        assert(bounds);
        assert(bounds.y >= 0 && bounds.y + bounds.height <= 900,
          'The matching history row must be inside the picture');
        const path = `${directory}/${name}-${width}.png`;
        await page.screenshot({ path });
        assert((await readFile(path)).length > 0);
        saved.add(name);
      }
      await checkChangeHistory(page, picture);
      assert.deepEqual(saved, new Set(['10-limit-history', '10-group-history']));
      const paginated = `<oc-audit><h1>Change history</h1><div id="rows">
        <article>budget.ceiling_set</article><button onclick="older()">Older history</button>
        </div></oc-audit><script>
        function older() {
          document.querySelector('#rows').innerHTML = '';
          setTimeout(showOlder, 600);
        }
        function showOlder() {
          document.querySelector('#rows').innerHTML = '<article>team.created</article>';
        }
        </script>`;
      await page.setContent(paginated);
      saved.clear();
      await checkChangeHistory(page, picture);
      assert.deepEqual(saved, new Set(['10-limit-history', '10-group-history']));
      await page.setContent('<oc-audit><h1>Change history</h1><article>Unrelated</article></oc-audit>');
      await assert.rejects(checkChangeHistory(page, picture),
        /Change history shows limits and groups/u);
    }
  } finally {
    await browser.close();
    await rm(directory, { recursive: true, force: true });
  }
}
test('history pictures show both matching rows at both widths and missing rows still fail',
  picturesShowHistoryRows);

async function smokeRequiresSavedPictures() {
  const directory = await mkdtemp(join(tmpdir(), 'smoke-pictures-'));
  const owner = new RehearsalPage();
  const member = new RehearsalPage();
  member.refusalMissing = false;
  const origin = 'https://rehearsal.example.invalid';
  const options = { origin, cookie: '', directory };
  const budget = { sequence: 1, defaultPayingGroupId: null, periodStart: null,
    todayCents: 10, monthCents: 10, reservedCents: 0, ceilingCents: 1000,
    dailyCeilingCents: 700, ceilings: [] };
  const saved = new Set<string>();
  async function fetchFixture(address: string, init?: RequestInit) {
    const url = new URL(address);
    const prefix = '/api/org/models/changes/';
    if (url.pathname.startsWith(prefix)) {
      const id = url.pathname.slice(prefix.length);
      if (saved.has(id)) {
        return Response.json({ status: 'appended' });
      }
      return Response.json({}, { status: 404 });
    }
    assert.equal(url.pathname, '/api/org/models');
    if (init?.method === 'POST') {
      const data = JSON.parse(String(init.body)) as {
        commandId: string; ceilingCents: number; dailyCeilingCents: number;
      };
      saved.add(data.commandId);
      budget.ceilingCents = data.ceilingCents;
      budget.dailyCeilingCents = data.dailyCeilingCents;
    }
    return Response.json({ budget });
  }
  async function missingPicture(): Promise<void> {
    throw new Error('Synthetic picture failure');
  }
  const network = mock.method(globalThis, 'fetch', fetchFixture);
  try {
    for (const width of [1280, 390]) {
      const result = await demoBrowser(owner as unknown as Page, member as unknown as Page,
        options, `${origin}/workspace?conversation=private`, directory, width);
      assert.equal(result.result, 'PASS');
      assert.equal(result.steps.length, 6);
      for (const step of result.steps) {
        assert.equal(step.result, 'PASS');
        for (const person of ['owner', 'member']) {
          const path = `${directory}/${step.name}-${person}-${width}.png`;
          assert.equal(await readFile(path, 'utf8'), 'Synthetic picture fixture');
        }
      }
    }
    const pictures = mock.method(member, 'screenshot', missingPicture);
    try {
      const result = await demoBrowser(owner as unknown as Page, member as unknown as Page,
        options, `${origin}/workspace?conversation=private`, directory, 390);
      assert.equal(result.result, 'FAIL');
      for (const step of result.steps) {
        assert.equal(step.result, 'FAIL', 'A failed member picture cannot pass the step');
      }
    } finally {
      pictures.mock.restore();
    }
    assert.equal(budget.dailyCeilingCents, 700);
  } finally {
    network.mock.restore();
    await rm(directory, { recursive: true, force: true });
  }
}
test('every smoke PASS saves both browser pictures and a missing picture fails',
  smokeRequiresSavedPictures);
