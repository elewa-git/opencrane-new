import { TestBed } from '@angular/core/testing';
import { z } from 'zod';
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

function json(value: unknown, status = 200): Promise<Response> {
  const response = new Response(JSON.stringify(value), {
    status, headers: { 'content-type': 'application/json' },
  });
  return Promise.resolve(response);
}

describe('welcome survey', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  function open(progress: unknown = emptyProgress) {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      if (url === '/auth/me') return json({ authenticated: true, user: { name: 'Alex' } });
      if (url === '/api/onboarding') {
        if (progress === null) return json({ status: 'unavailable' }, 503);
        return json(progress);
      }
      return json({ status: 'unknown' }, 503);
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
      expect(element.querySelector('h1')?.textContent).toContain('Welcome survey');
      expect(element.textContent).not.toContain('Checking your progress');
    });
    if (element.querySelector('#survey-name')) {
      await vi.waitFor(() => {
        fixture.detectChanges();
        expect(element.querySelector<HTMLInputElement>('#survey-name')?.value).toBe('Alex');
      });
    }
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
    const rawBody = posts[0]?.[1]?.body;
    if (typeof rawBody !== 'string') throw new Error('Missing save body');
    const parsedBody: unknown = JSON.parse(rawBody);
    const commandId = z.object({ commandId: z.string() }).parse(parsedBody).commandId;
    element.querySelector<HTMLButtonElement>('oc-shared-state button')!.click();
    await vi.waitFor(() => {
      const statusUrl = `/api/personal/changes/${commandId}`;
      expect(fetchSpy.mock.calls.some(([url]) => url === statusUrl)).toBe(true);
    });
    expect(fetchSpy.mock.calls.filter(([url]) => url === '/api/onboarding/survey')).toHaveLength(1);
  });

  it('treats a lost network reply as unknown and does not resend', async () => {
    const { fixture, element, fetchSpy } = open();
    await ready(fixture, element);
    fetchSpy.mockImplementation((url) => {
      if (url === '/api/onboarding/survey') return Promise.reject(new Error('offline'));
      return json({ status: 'unknown' });
    });
    element.querySelector<HTMLButtonElement>('button[type=submit]')!.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.textContent).toContain('Check status');
    });
    expect(fetchSpy.mock.calls.filter(([url]) => url === '/api/onboarding/survey')).toHaveLength(1);
  });

  it('does not send a saved answer again when moving forward', async () => {
    const { fixture, element, fetchSpy } = open(savedProgress);
    await ready(fixture, element);
    element.querySelector<HTMLButtonElement>('button')!.click();
    fixture.detectChanges();
    element.querySelector<HTMLButtonElement>('button[type=submit]')!.click();
    fixture.detectChanges();
    expect(element.textContent).toContain('Step 2 of 4');
    expect(fetchSpy.mock.calls.filter(([url]) => url === '/api/onboarding/survey')).toHaveLength(0);
  });

  it('locks Continue while its one request is pending', async () => {
    const { fixture, element, fetchSpy } = open();
    await ready(fixture, element);
    fetchSpy.mockImplementation((url) => {
      if (url === '/api/onboarding/survey') return new Promise<Response>(() => {});
      return json({ authenticated: true, user: { name: 'Alex' } });
    });
    const continueButton = element.querySelector<HTMLButtonElement>('button[type=submit]')!;
    continueButton.click();
    continueButton.click();
    fixture.detectChanges();
    expect(fetchSpy.mock.calls.filter(([url]) => url === '/api/onboarding/survey')).toHaveLength(1);
  });

  for (const [status, body, expected] of [
    [422, 'invalid', 'Try again'],
    [503, 'unavailable', 'Try again'],
    [425, 'access_applying', 'Access is still being set up'],
  ] as const) {
    it(`keeps the answer after a ${status} refusal`, async () => {
      const { fixture, element, fetchSpy } = open();
      await ready(fixture, element);
      fetchSpy.mockImplementation((url) => {
        if (url === '/api/onboarding/survey') return json({ status: body }, status);
        return json({ authenticated: true, user: { name: 'Alex' } });
      });
      element.querySelector<HTMLButtonElement>('button[type=submit]')!.click();
      await vi.waitFor(() => {
        fixture.detectChanges();
        expect(element.textContent).toContain(expected);
      });
      expect(element.querySelector<HTMLInputElement>('#survey-name')?.value).toBe('Alex');
    });
  }

  it('rereads progress after a conflict and keeps the typed answer for review', async () => {
    const { fixture, element, fetchSpy } = open();
    await ready(fixture, element);
    fetchSpy.mockImplementation((url) => {
      if (url === '/api/onboarding/survey') return json({ status: 'conflict' }, 409);
      if (url === '/api/onboarding') return json(savedProgress);
      return json({ authenticated: true, user: { name: 'Alex' } });
    });
    const name = element.querySelector<HTMLInputElement>('#survey-name')!;
    name.value = 'Taylor';
    name.dispatchEvent(new Event('input'));
    element.querySelector<HTMLButtonElement>('button[type=submit]')!.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.textContent).toContain('Review answer');
    });
    expect(element.querySelector<HTMLInputElement>('#survey-name')?.value).toBe('Taylor');
    expect(fetchSpy.mock.calls.filter(([url]) => url === '/api/onboarding')).toHaveLength(2);
  });

  for (const [status, heading, link] of [
    [401, 'Your session has expired', 'Sign in again'],
    [403, 'Your access has changed', 'Reload'],
  ] as const) {
    it(`clears private details after ${status}`, async () => {
      const { fixture, element, fetchSpy } = open();
      await ready(fixture, element);
      fetchSpy.mockImplementation((url) => {
        if (url === '/api/onboarding/survey') return json({ status: 'refused' }, status);
        return json({ authenticated: true, user: { name: 'Alex' } });
      });
      element.querySelector<HTMLButtonElement>('button[type=submit]')!.click();
      await vi.waitFor(() => {
        fixture.detectChanges();
        expect(element.textContent).toContain(heading);
      });
      expect(element.querySelector('#survey-name')).toBeNull();
      expect(element.querySelector('.button-link')?.textContent).toContain(link);
    });
  }

  it('ignores an identity reply that arrives after access refusal', async () => {
    let finishIdentity: ((response: Response) => void) | undefined;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      if (url === '/api/onboarding') return json(emptyProgress);
      if (url === '/auth/me') {
        return new Promise<Response>((resolve) => { finishIdentity = resolve; });
      }
      return json({ status: 'refused' }, 403);
    });
    TestBed.configureTestingModule({ imports: [SurveyScreen] });
    const fixture = TestBed.createComponent(SurveyScreen);
    fixture.detectChanges();
    const element: unknown = fixture.nativeElement;
    if (!(element instanceof HTMLElement)) throw new Error('Missing survey root');
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.querySelector('#survey-name')).not.toBeNull();
    });
    const name = element.querySelector<HTMLInputElement>('#survey-name')!;
    name.value = 'Taylor';
    name.dispatchEvent(new Event('input'));
    element.querySelector<HTMLButtonElement>('button[type=submit]')!.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.textContent).toContain('Your access has changed');
    });
    finishIdentity?.(new Response(JSON.stringify({ authenticated: true,
      user: { name: 'Old private name' } })));
    await Promise.resolve();
    fixture.detectChanges();
    expect(element.textContent).not.toContain('Old private name');
    expect(element.querySelector('#survey-name')).toBeNull();
    expect(fetchSpy.mock.calls.filter(([url]) => url === '/api/onboarding/survey')).toHaveLength(1);
  });

  it('shows a failed progress read and lets a RAM draft start without a blind save', async () => {
    const { fixture, element, fetchSpy } = open(null);
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.textContent).toContain('Start again');
    });
    element.querySelector<HTMLButtonElement>('button')?.click();
    fixture.detectChanges();
    expect(fetchSpy.mock.calls.filter(([url]) => url === '/api/onboarding/survey')).toHaveLength(0);
  });
});
