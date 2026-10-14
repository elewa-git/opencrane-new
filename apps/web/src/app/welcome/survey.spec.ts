import { TestBed } from '@angular/core/testing';
import { SurveyScreen } from './survey';

const emptyProgress = {
  state: 'not_started',
  survey: { generation: 1, position: 0, nextStep: 1, steps: [] },
};
const savedProgress = {
  state: 'survey',
  survey: { generation: 1, position: 1, nextStep: 2, steps: [{
    status: 'confirmed', commandId: 'saved', eventId: 'event', position: 1,
    operation: 'onboarding.survey_step_saved', time: '2026-10-14T09:30:00.000Z',
    answers: { step: 1, preferredName: 'Alex', pronouns: null },
  }] },
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status, headers: { 'content-type': 'application/json' },
  });
}

describe('welcome survey', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  function open(progress: unknown = emptyProgress) {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (url === '/auth/me') return json({ authenticated: true, user: { name: 'Alex' } });
      if (url === '/api/onboarding') return json(progress);
      return json({ status: 'unavailable' }, 503);
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
      expect(element.querySelector('h1')?.textContent).toContain('Welcome survey');
      expect(element.textContent).not.toContain('Checking your progress');
    });
  }

  it('resumes the first unsaved step, focuses its heading and shows the saved time', async () => {
    const { fixture, element } = open(savedProgress);
    await ready(fixture, element);
    expect(element.textContent).toContain('Step 2 of 4');
    expect(element.querySelector('h2')).toBe(document.activeElement);
    expect(element.querySelector('time')?.dateTime).toBe('2026-10-14T09:30:00.000Z');
  });

  it('opens step one for a new person and rejects invalid names without posting', async () => {
    const { fixture, element, fetchSpy } = open();
    await ready(fixture, element);
    const name = element.querySelector<HTMLInputElement>('#survey-name');
    const continueButton = element.querySelector<HTMLButtonElement>('button[type=submit]');
    expect(name).not.toBeNull();
    expect(continueButton).not.toBeNull();
    for (const value of ['', 'x'.repeat(201), 'Bad\u0001name']) {
      name!.value = value;
      name!.dispatchEvent(new Event('input'));
      continueButton!.click();
      fixture.detectChanges();
      expect(name?.getAttribute('aria-describedby')).toContain('name-error');
    }
    expect(fetchSpy.mock.calls.filter(([url]) => url === '/api/onboarding/survey')).toHaveLength(0);
  });

  it('keeps one uncertain save and checks its original id without posting again', async () => {
    const { fixture, element, fetchSpy } = open();
    await ready(fixture, element);
    const name = element.querySelector<HTMLInputElement>('#survey-name')!;
    name.value = 'Alex';
    name.dispatchEvent(new Event('input'));
    element.querySelector<HTMLButtonElement>('button[type=submit]')!.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.textContent).toContain('Check status');
    });
    const posts = fetchSpy.mock.calls.filter(([url]) => url === '/api/onboarding/survey');
    expect(posts).toHaveLength(1);
    const body = JSON.parse(String(posts[0][1]?.body)) as { commandId: string };
    element.querySelector<HTMLButtonElement>('oc-shared-state button')!.click();
    await vi.waitFor(() => {
      const statusUrl = `/api/personal/changes/${body.commandId}`;
      expect(fetchSpy.mock.calls.some(([url]) => url === statusUrl)).toBe(true);
    });
    expect(fetchSpy.mock.calls.filter(([url]) => url === '/api/onboarding/survey')).toHaveLength(1);
  });

  it('shows a failed progress read and lets a RAM draft start without a blind save', async () => {
    const { fixture, element, fetchSpy } = open(emptyProgress);
    fetchSpy.mockImplementation(async (url) => {
      if (url === '/api/onboarding') return json({ status: 'unavailable' }, 503);
      return json({ authenticated: true, user: { name: 'Alex' } });
    });
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.textContent).toContain('Start again');
    });
    element.querySelector<HTMLButtonElement>('button')?.click();
    fixture.detectChanges();
    expect(fetchSpy.mock.calls.filter(([url]) => url === '/api/onboarding/survey')).toHaveLength(0);
  });
});
