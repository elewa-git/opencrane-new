import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium, type Page } from 'playwright';
import { qualifyOwnershipTransfer, type Phase4Assertion } from './browser-phase4.ts';

async function refusesAnAdminFixture() {
  const assertions: Phase4Assertion[] = [];
  async function get() {
    function status() {
      return 200;
    }
    async function json() {
      return { owners: [{ memberId: 'separate-owner', role: 'owner' }],
        viewer: { memberId: 'zitadel-owner', role: 'admin' } };
    }
    return { status, json };
  }
  function url() {
    return 'http://fixture.invalid/org/people/owners';
  }
  const page = { request: { get }, url } as unknown as Page;
  const options = { assertions } as Parameters<typeof qualifyOwnershipTransfer>[0];
  async function runJourney() {
    await qualifyOwnershipTransfer(options, page, '/unused');
  }
  await assert.rejects(runJourney, /requires a current Owner/);
  assert.equal(assertions.some(isUnprovedOwnership), false);
}

function isUnprovedOwnership(assertion: Phase4Assertion): boolean {
  return assertion.id === 'ownership.transfer' && assertion.status === 'NOT PROVEN';
}

test('ownership qualification refuses an Admin fixture instead of silently skipping',
  refusesAnAdminFixture);

async function preparesAndRestoresSavedAccounts() {
  const { prepareOwnershipJourney, restoreOwnershipJourney } =
    await import('./ownership-fixture.ts');
  const roles = new Map<string, string>([
    ['jente-rosseel', 'owner'], ['zitadel-owner', 'admin'], ['zitadel-member', 'member'],
  ]);
  const commands: Array<{ actor: string; action: string; target?: string }> = [];
  let sequence = 1;
  function client(actor: string) {
    function reply(body: unknown) {
      function status() {
        return 200;
      }
      async function json() {
        return body;
      }
      return { status, json };
    }
    async function get(url: string) {
      if (url.includes('/changes/')) {
        return reply({ projection: { content: 'current', iam: 'current' } });
      }
      if (url.endsWith('/api/ownership')) {
        const owners = [];
        for (const [memberId, role] of roles) {
          if (role === 'owner') owners.push({ memberId, role });
        }
        return reply({ sequence, owners, viewer: { memberId: actor, role: roles.get(actor) } });
      }
      const target = url.split('/').at(-1)!;
      return reply({ memberSequence: sequence, role: roles.get(target) });
    }
    async function post(url: string, options: { data: Record<string, unknown> }) {
      const data = options.data;
      assert.equal(data['expectedSequence'], sequence, 'Use the latest saved position');
      assert(['owner', 'admin'].includes(roles.get(actor)!));
      if (url.endsWith('/role')) {
        const target = url.split('/').at(-2)!;
        assert.notEqual(roles.get(target), 'owner', 'Never demote through the member stream');
        roles.set(target, String(data['newRole']));
        commands.push({ actor, action: 'role', target });
      } else {
        assert.equal(roles.get(actor), 'owner', 'Only an owner may change ownership');
        if (data['action'] === 'transfer') {
          const target = String(data['successorId']);
          roles.set(target, 'owner');
          commands.push({ actor, action: 'transfer', target });
        } else {
          const currentOwners = [];
          for (const [memberId, role] of roles) {
            if (role === 'owner') currentOwners.push(memberId);
          }
          assert(currentOwners.length > 1, 'Never leave the fixture without an owner');
          roles.set(actor, 'admin');
          commands.push({ actor, action: 'step_down' });
        }
      }
      sequence += 1;
      return reply({ status: 'appended' });
    }
    return { get, post } as unknown as import('playwright').APIRequestContext;
  }
  const separate = client('jente-rosseel');
  const owner = client('zitadel-owner');
  const member = client('zitadel-member');
  for (let attempt = 0; attempt < 2; attempt++) {
    await prepareOwnershipJourney(separate, owner, 'http://fixture.invalid');
    assert.equal(roles.get('jente-rosseel'), 'admin');
    assert.equal(roles.get('zitadel-owner'), 'owner');
    // Stand in for the browser's reviewed appointment, step-down and Member role change.
    roles.set('zitadel-member', 'owner');
    roles.set('zitadel-owner', 'member');
    await restoreOwnershipJourney(separate, member, 'http://fixture.invalid');
    assert.deepEqual([...roles], [
      ['jente-rosseel', 'owner'], ['zitadel-owner', 'admin'], ['zitadel-member', 'member'],
    ]);
  }
  assert.deepEqual(commands.slice(0, 2), [
    { actor: 'jente-rosseel', action: 'transfer', target: 'zitadel-owner' },
    { actor: 'jente-rosseel', action: 'step_down' },
  ]);
  assert.equal(commands.length, 12, 'Each repeat prepares and restores through six commands');
}

test('ownership fixture uses authorised commands and restores accounts for a saved-data repeat',
  preparesAndRestoresSavedAccounts);

async function doesNotReuseAnEarlierTransfer() {
  const { ownershipTransferEvent } = await import('./browser-phase4.ts');
  async function* readStream() {
    yield { event: { silo: 'test', type: 'ownership.transferred', commandId: 'earlier-attempt',
      data: { memberId: 'zitadel-member', transferredBy: 'zitadel-owner' } } };
  }
  const store = { readStream } as unknown as import('@opencrane/event-store').EventStore;
  async function readCurrentTransfer() {
    await ownershipTransferEvent(store, 'test', 'zitadel-member', 'zitadel-owner',
      'current-attempt');
  }
  await assert.rejects(readCurrentTransfer, /No ownership transfer/);
}

test('saved-data evidence cannot use an earlier ownership transfer as the current result',
  doesNotReuseAnEarlierTransfer);

async function toleratesAStatusControlThatHasGone() {
  const { clickStatusWhenEnabled } = await import('./browser-phase4.ts');
  async function count() {
    return 1;
  }
  async function isEnabled() {
    throw new Error('The status button was removed after the count');
  }
  async function evaluateAll(check: (elements: Element[]) => boolean) {
    return check([]);
  }
  const button = { count, isEnabled, evaluateAll } as unknown as import('playwright').Locator;
  assert.equal(await clickStatusWhenEnabled(button), false,
    'A completed change may remove its read-only status control');
}

test('a status control that disappears after completion does not fail the journey',
  toleratesAStatusControlThatHasGone);


async function activatesOnlyAnAvailableStatusControl() {
  const { clickStatusWhenEnabled } = await import('./browser-phase4.ts');
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  try {
    const page = await browser.newPage();
    await page.setContent('<button disabled>Check status</button><output>0</output>');
    await page.evaluate(installStatusCounter);
    const control = page.getByRole('button', { name: 'Check status', exact: true });
    assert.equal(await clickStatusWhenEnabled(control), false);
    assert.equal(await page.locator('output').innerText(), '0');
    await page.evaluate(enableStatusControl);
    assert.equal(await clickStatusWhenEnabled(control), true);
    assert.equal(await page.locator('output').innerText(), '1');
    assert.equal(await clickStatusWhenEnabled(control), false);
  } finally {
    await browser.close();
  }
}

function installStatusCounter() {
  const button = document.querySelector('button');
  const output = document.querySelector('output');
  if (!button || !output) throw new Error('The status fixture is missing');
  function recordClick() {
    if (!button || !output) throw new Error('The status fixture was removed too early');
    output.textContent = String(Number(output.textContent) + 1);
    button.remove();
  }
  button.addEventListener('click', recordClick);
}

function enableStatusControl() {
  const button = document.querySelector('button');
  if (!button) throw new Error('The status control is missing');
  button.disabled = false;
}

test('status checks ignore disabled or removed controls and activate an available control once',
  activatesOnlyAnAvailableStatusControl);
