import { TestBed } from '@angular/core/testing';
import { z } from 'zod';
import { SurveyScreen } from './survey';

const firstStep = { time: '2026-10-14T09:30:00.000Z',
  answers: { step: 1, preferredName: 'Alex', pronouns: null } };
const secondStep = { time: '2026-10-14T09:31:00.000Z',
  answers: { step: 2, workDescription: 'Teaching', groupIds: ['group-a'] } };
const oneStep = { state: 'survey', survey: {
  generation: 2, position: 7, nextStep: 2, steps: [firstStep],
} };
const twoSteps = { state: 'survey', survey: {
  generation: 2, position: 8, nextStep: 3, steps: [firstStep, secondStep],
} };
const groups = { rows: [{ groupId: 'group-a', name: 'Teachers' }], next: null };

function reply(value: unknown, status = 200): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(value), { status }));
}

function requestsFor(spy: ReturnType<typeof open>['fetchSpy'], path: string) {
  return spy.mock.calls.filter(([url]) => url === path);
}

const postBodySchema = z.object({
  commandId: z.string(),
  answers: z.object({ step: z.literal(2), workDescription: z.string(),
    groupIds: z.array(z.string()) }),
}).passthrough();

function postedBody(spy: ReturnType<typeof open>['fetchSpy']) {
  const posts = requestsFor(spy, '/api/onboarding/survey');
  const rawBody: unknown = posts[0]?.[1]?.body;
  if (typeof rawBody !== 'string') throw new Error('Missing save body');
  const parsed: unknown = JSON.parse(rawBody);
  return postBodySchema.parse(parsed);
}

function open(progress: unknown = oneStep, groupReply: unknown = groups) {
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
    if (url === '/api/onboarding') return reply(progress);
    if (url === '/api/chat/groups?limit=16') return reply(groupReply);
    if (url === '/auth/me') return reply({ authenticated: true, user: { name: 'Alex' } });
    return reply({ status: 'unavailable' }, 503);
  });
  TestBed.configureTestingModule({ imports: [SurveyScreen] });
  const fixture = TestBed.createComponent(SurveyScreen);
  fixture.detectChanges();
  const element: unknown = fixture.nativeElement;
  if (!(element instanceof HTMLElement)) throw new Error('Missing survey root');
  return { fixture, element, fetchSpy };
}

async function ready(fixture: ReturnType<typeof open>['fixture'], element: HTMLElement) {
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(element.querySelector('#survey-work')).not.toBeNull();
    expect(element.textContent).toContain('Teachers');
  });
}

function enter(element: HTMLElement, value: string): void {
  const field = element.querySelector<HTMLTextAreaElement>('#survey-work');
  if (!field) throw new Error('Missing work field');
  field.value = value;
  field.dispatchEvent(new Event('input'));
  element.querySelector<HTMLButtonElement>('button[type=submit]')?.click();
}

describe('survey work step', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  it('resumes at step three with both saved steps, then Back reads current groups', async () => {
    const { fixture, element, fetchSpy } = open(twoSteps, { ...groups, next: 'later' });
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.textContent).toContain('Steps 1–2 saved');
    });
    expect(element.querySelector('time')?.dateTime).toBe(secondStep.time);
    expect(element.textContent).toContain('Step 3 of 4');
    expect(requestsFor(fetchSpy, '/api/chat/groups?limit=16')).toHaveLength(0);
    element.querySelector<HTMLButtonElement>('button')?.click();
    await ready(fixture, element);
    expect(element.querySelector<HTMLTextAreaElement>('#survey-work')?.value).toBe('Teaching');
    expect(element.textContent).toContain('Only the first 16 groups are used.');
    expect(requestsFor(fetchSpy, '/api/chat/groups?limit=16')).toHaveLength(1);
  });

  it('posts one checked work answer, rereads, and skips an unchanged answer', async () => {
    const consoleLog = vi.spyOn(console, 'log');
    const storageWrite = vi.spyOn(Storage.prototype, 'setItem');
    const { fixture, element, fetchSpy } = open();
    await ready(fixture, element);
    fetchSpy.mockImplementation((url) => {
      if (url === '/api/onboarding/survey') return reply({ status: 'confirmed' });
      if (url === '/api/onboarding') return reply(twoSteps);
      if (url === '/api/chat/groups?limit=16') return reply(groups);
      return reply({ authenticated: true, user: { name: 'Alex' } });
    });
    enter(element, '  Teaching  ');
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.textContent).toContain('Step 3 of 4');
    });
    const posts = requestsFor(fetchSpy, '/api/onboarding/survey');
    expect(posts).toHaveLength(1);
    const body = postedBody(fetchSpy);
    expect(body).toMatchObject({ generation: 2, expectedPosition: 7,
      answers: { step: 2, workDescription: 'Teaching', groupIds: ['group-a'] } });
    element.querySelector<HTMLButtonElement>('button')?.click();
    await ready(fixture, element);
    enter(element, 'Teaching');
    fixture.detectChanges();
    expect(requestsFor(fetchSpy, '/api/onboarding/survey')).toHaveLength(1);
    expect(location.href).not.toContain('Teaching');
    expect(location.href).not.toContain('Teachers');
    expect(consoleLog.mock.calls.flat().join(' ')).not.toContain('Teaching');
    expect(consoleLog.mock.calls.flat().join(' ')).not.toContain('Teachers');
    expect(storageWrite).not.toHaveBeenCalled();
  });

  it('accepts 4096 bytes and rejects overflow, empty and control characters', async () => {
    const { fixture, element, fetchSpy } = open();
    await ready(fixture, element);
    for (const invalid of [' ', '界'.repeat(1366), 'Bad\u0001text']) {
      enter(element, invalid);
      fixture.detectChanges();
      expect(element.querySelector('#survey-work')?.getAttribute('aria-describedby'))
        .toContain('work-error');
    }
    expect(requestsFor(fetchSpy, '/api/onboarding/survey')).toHaveLength(0);
    fetchSpy.mockImplementation((url) => {
      if (url === '/api/onboarding/survey') return new Promise<Response>(() => {});
      return reply(oneStep);
    });
    enter(element, 'a'.repeat(4096));
    await vi.waitFor(() => expect(requestsFor(fetchSpy, '/api/onboarding/survey')).toHaveLength(1));
  });

  it('blocks saving after a failed groups read and retries only the read', async () => {
    const { fixture, element, fetchSpy } = open(oneStep, null);
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.textContent).toContain('Try again');
    });
    expect(element.querySelector('button[type=submit]')).toBeNull();
    fetchSpy.mockImplementation((url) => {
      if (url === '/api/chat/groups?limit=16') return reply(groups);
      return reply({ status: 'unexpected' }, 503);
    });
    element.querySelector<HTMLButtonElement>('button')?.click();
    await ready(fixture, element);
    expect(requestsFor(fetchSpy, '/api/onboarding/survey')).toHaveLength(0);
  });

  it('uses no group ids when the current membership has none', async () => {
    const { fixture, element, fetchSpy } = open(oneStep, { rows: [], next: null });
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.textContent).toContain('You are not in any groups.');
    });
    fetchSpy.mockImplementation((url) => {
      if (url === '/api/onboarding/survey') return new Promise<Response>(() => {});
      return reply(oneStep);
    });
    enter(element, 'Teaching');
    await vi.waitFor(() => expect(requestsFor(fetchSpy, '/api/onboarding/survey')).toHaveLength(1));
    const body = postedBody(fetchSpy);
    expect(body.answers.groupIds).toEqual([]);
  });

  it('keeps an uncertain step two save for GET-only status checks', async () => {
    const { fixture, element, fetchSpy } = open();
    await ready(fixture, element);
    fetchSpy.mockImplementation((url) => {
      if (url === '/api/onboarding/survey') return Promise.reject(new Error('offline'));
      return reply({ status: 'unknown' }, 503);
    });
    enter(element, 'Teaching');
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.textContent).toContain('Check status');
    });
    expect(Array.from(element.querySelectorAll('button')).some(button =>
      button.textContent?.trim() === 'Back')).toBe(false);
    const posts = requestsFor(fetchSpy, '/api/onboarding/survey');
    expect(posts).toHaveLength(1);
    const body = postedBody(fetchSpy);
    element.querySelector<HTMLButtonElement>('oc-shared-state button')?.click();
    await vi.waitFor(() => {
      expect(requestsFor(fetchSpy, `/api/personal/changes/${body.commandId}`)).toHaveLength(1);
    });
    expect(requestsFor(fetchSpy, '/api/onboarding/survey')).toHaveLength(1);
  });

  it('rereads a conflict and keeps the typed work for review', async () => {
    const { fixture, element, fetchSpy } = open();
    await ready(fixture, element);
    fetchSpy.mockImplementation((url) => {
      if (url === '/api/onboarding/survey') return reply({ status: 'conflict' }, 409);
      if (url === '/api/onboarding') return reply(oneStep);
      return reply(groups);
    });
    enter(element, 'My changed work');
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.textContent).toContain('Review answer');
    });
    expect(element.querySelector<HTMLTextAreaElement>('#survey-work')?.value)
      .toBe('My changed work');
    expect(requestsFor(fetchSpy, '/api/onboarding')).toHaveLength(2);
    expect(requestsFor(fetchSpy, '/api/onboarding/survey')).toHaveLength(1);
  });

  it('ignores a late group reply after leaving the work step', async () => {
    const { fixture, element, fetchSpy } = open(twoSteps);
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.textContent).toContain('Step 3 of 4');
    });
    let finishGroups: ((response: Response) => void) | undefined;
    fetchSpy.mockImplementation((url) => {
      if (url === '/api/chat/groups?limit=16') {
        return new Promise<Response>(resolve => { finishGroups = resolve; });
      }
      return reply(twoSteps);
    });
    element.querySelector<HTMLButtonElement>('button')?.click();
    fixture.detectChanges();
    expect(element.textContent).toContain('Checking your current groups');
    const back = Array.from(element.querySelectorAll('button'))
      .find(button => button.textContent?.trim() === 'Back');
    back?.click();
    finishGroups?.(await reply({ rows: [{ groupId: 'group-a', name: 'Private group' }],
      next: null }));
    await Promise.resolve();
    fixture.detectChanges();
    expect(element.textContent).not.toContain('Private group');
  });

  for (const status of [401, 403]) {
    it(`clears saved answers when groups return ${status}`, async () => {
      const { fixture, element, fetchSpy } = open(twoSteps);
      await vi.waitFor(() => {
        fixture.detectChanges();
        expect(element.textContent).toContain('Steps 1–2 saved');
      });
      fetchSpy.mockImplementation((url) => {
        if (url === '/api/chat/groups?limit=16') return reply({}, status);
        return reply(twoSteps);
      });
      element.querySelector<HTMLButtonElement>('button')?.click();
      await vi.waitFor(() => {
        fixture.detectChanges();
        expect(element.textContent).toContain(status === 401
          ? 'Your session has expired' : 'Your access has changed');
      });
      expect(element.textContent).not.toContain('Teaching');
      expect(element.textContent).not.toContain('Teachers');
      expect(element.querySelector('#survey-work')).toBeNull();
    });
  }

  it('rereads an edited first step and opens an empty work answer', async () => {
    const { fixture, element, fetchSpy } = open(twoSteps);
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.textContent).toContain('Step 3 of 4');
    });
    element.querySelector<HTMLButtonElement>('button')?.click();
    await ready(fixture, element);
    const back = Array.from(element.querySelectorAll('button'))
      .find(button => button.textContent?.trim() === 'Back');
    back?.click();
    fixture.detectChanges();
    expect(element.textContent).toContain('Changing step 1 clears later saved answers');
    const editedFirstStep = { ...firstStep, answers: { ...firstStep.answers,
      preferredName: 'Taylor' } };
    const afterEdit = { state: 'survey', survey: {
      generation: 2, position: 9, nextStep: 2, steps: [editedFirstStep],
    } };
    fetchSpy.mockImplementation((url) => {
      if (url === '/api/onboarding/survey') return reply({ status: 'confirmed' });
      if (url === '/api/onboarding') return reply(afterEdit);
      if (url === '/api/chat/groups?limit=16') return reply(groups);
      return reply({ authenticated: true, user: { name: 'Alex' } });
    });
    const name = element.querySelector<HTMLInputElement>('#survey-name');
    if (!name) throw new Error('Missing name field');
    name.value = 'Taylor';
    name.dispatchEvent(new Event('input'));
    element.querySelector<HTMLButtonElement>('button[type=submit]')?.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.querySelector<HTMLTextAreaElement>('#survey-work')?.value).toBe('');
    });
    expect(requestsFor(fetchSpy, '/api/onboarding/survey')).toHaveLength(1);
    expect(requestsFor(fetchSpy, '/api/onboarding')).toHaveLength(2);
  });
});
