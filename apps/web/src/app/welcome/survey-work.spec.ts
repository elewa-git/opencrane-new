import { TestBed } from '@angular/core/testing';
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
  const element = fixture.nativeElement as HTMLElement;
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
    const { fixture, element, fetchSpy } = open(twoSteps);
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
    expect(requestsFor(fetchSpy, '/api/chat/groups?limit=16')).toHaveLength(1);
  });

  it('posts one checked work answer, rereads, and skips an unchanged answer', async () => {
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
    const body = JSON.parse(String(posts[0]?.[1]?.body));
    expect(body).toMatchObject({ generation: 2, expectedPosition: 7,
      answers: { step: 2, workDescription: 'Teaching', groupIds: ['group-a'] } });
    element.querySelector<HTMLButtonElement>('button')?.click();
    await ready(fixture, element);
    enter(element, 'Teaching');
    fixture.detectChanges();
    expect(requestsFor(fetchSpy, '/api/onboarding/survey')).toHaveLength(1);
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
});
