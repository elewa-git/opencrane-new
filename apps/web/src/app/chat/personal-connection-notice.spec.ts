import { TestBed } from '@angular/core/testing';
import { PersonalConnectionNotice } from './personal-connection-notice';

async function explainsConsentRefusal() {
  function readNeeds() {
    return Promise.resolve(new Response(JSON.stringify({ rows: [{
      serverId: 'fixture', name: 'Demo server', reason: 'assistant_not_allowed',
    }] })));
  }
  vi.spyOn(globalThis, 'fetch').mockImplementation(readNeeds);
  const fixture = TestBed.createComponent(PersonalConnectionNotice);
  fixture.componentRef.setInput('assistantId', 'own');
  fixture.detectChanges();
  const rendered: unknown = fixture.nativeElement;
  if (!(rendered instanceof HTMLElement)) throw new Error('Missing connection notice');
  const element = rendered;
  function refusalShown() {
    fixture.detectChanges();
    expect(element.textContent).toContain('Your key is not allowed for this assistant');
  }
  await vi.waitFor(refusalShown);
  expect(element.querySelector('a')?.getAttribute('href')).toBe('/account/tools?serverId=fixture');
  expect(element.querySelector('a')?.textContent).toContain('My tools');
  expect(element.textContent).not.toContain('Connect your key');
  expect(element.textContent).not.toContain('Demo server');
  fixture.destroy();
  vi.restoreAllMocks();
}
it('explains a refused assistant without naming an account and links to My tools',
  explainsConsentRefusal);
