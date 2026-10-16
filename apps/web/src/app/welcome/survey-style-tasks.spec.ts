import { TestBed } from '@angular/core/testing';
import { z } from 'zod';
import { SurveyScreen } from './survey';

const name = { time: '2026-10-14T09:30:00.000Z',
  answers: { step: 1, preferredName: 'Alex', pronouns: null } };
const work = { time: '2026-10-14T09:31:00.000Z',
  answers: { step: 2, workDescription: 'Teaching', groupIds: [] } };
const style = { time: '2026-10-14T09:32:00.000Z',
  answers: { step: 3, tone: 'warm', length: 'brief', citations: true } };
const tasks = { time: '2026-10-14T09:33:00.000Z',
  answers: { step: 4, tasks: ['draft_documents'], ownTask: null } };

function progress(steps: unknown[]) {
  return { state: steps.length === 4 ? 'review' : 'survey', survey: {
    generation: 2, position: steps.length + 5,
    nextStep: steps.length === 4 ? null : steps.length + 1, steps,
  } };
}

function reply(value: unknown, status = 200): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(value), { status }));
}

function button(root: HTMLElement, label: string): HTMLButtonElement {
  const found = Array.from(root.querySelectorAll('button'))
    .find(candidate => candidate.textContent?.trim() === label);
  if (!found) throw new Error(`Missing ${label}`);
  return found;
}

function open(initial = progress([name, work])) {
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
    if (url === '/api/onboarding') return reply(initial);
    if (url === '/auth/me') return reply({ authenticated: true, user: { name: 'Alex' } });
    if (url === '/api/chat/groups?limit=16') return reply({ rows: [], next: null });
    return reply({ status: 'unavailable' }, 503);
  });
  TestBed.configureTestingModule({ imports: [SurveyScreen] });
  const fixture = TestBed.createComponent(SurveyScreen);
  fixture.detectChanges();
  const root: unknown = fixture.nativeElement;
  if (!(root instanceof HTMLElement)) throw new Error('Missing survey root');
  return { root, fixture, fetchSpy };
}

async function show(root: HTMLElement, fixture: ReturnType<typeof open>['fixture'], step: number) {
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(root.textContent).toContain(`Step ${step} of 4`);
    expect(root.querySelector('h2')).not.toBeNull();
  });
}

function posts(spy: ReturnType<typeof open>['fetchSpy']) {
  return spy.mock.calls.filter(([url]) => url === '/api/onboarding/survey');
}

describe('survey style and tasks', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  it('moves within grouped choices with arrows and selects with Space', async () => {
    const { root, fixture, fetchSpy } = open();
    await show(root, fixture, 3);
    const direct = root.querySelector<HTMLElement>('[role=radio][data-value=direct]')!;
    direct.focus();
    direct.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    fixture.detectChanges();
    expect(document.activeElement?.getAttribute('data-value')).toBe('warm');
    const formal = root.querySelector<HTMLElement>('[role=radio][data-value=formal]')!;
    formal.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    fixture.detectChanges();
    expect(formal.getAttribute('aria-checked')).toBe('true');
    button(root, 'Back').click();
    await show(root, fixture, 2);
    expect(posts(fetchSpy)).toHaveLength(0);
  });

  it('saves style once and advances only after confirmation, then restores it on Back', async () => {
    const screen = open();
    await show(screen.root, screen.fixture, 3);
    let finishSave: ((response: Response) => void) | undefined;
    let progressReads = 0;
    screen.fetchSpy.mockImplementation((url) => {
      if (url === '/api/onboarding/survey') {
        return new Promise<Response>(resolve => { finishSave = resolve; });
      }
      if (url === '/api/onboarding') {
        progressReads += 1;
        return reply(progress([name, work, style]));
      }
      return reply({ authenticated: true, user: { name: 'Alex' } });
    });
    button(screen.root, 'Warm').click();
    button(screen.root, 'Continue').click();
    await vi.waitFor(() => expect(posts(screen.fetchSpy)).toHaveLength(1));
    expect(screen.root.textContent).toContain('Step 3 of 4');
    finishSave!(new Response('{}'));
    await vi.waitFor(() => expect(progressReads).toBe(1));
    expect(posts(screen.fetchSpy)).toHaveLength(1);
    await show(screen.root, screen.fixture, 4);
    await vi.waitFor(() => {
      screen.fixture.detectChanges();
      expect(button(screen.root, 'Back')).toBeTruthy();
    });
    button(screen.root, 'Back').click();
    await show(screen.root, screen.fixture, 3);
    expect(screen.root.querySelector('[data-value=warm]')?.getAttribute('aria-checked')).toBe('true');
    expect(posts(screen.fetchSpy)).toHaveLength(1);
  });

  it('checks task text and saves distinct choices without any grant or install', async () => {
    const screen = open(progress([name, work, style]));
    await show(screen.root, screen.fixture, 4);
    const ownTask = screen.root.querySelector<HTMLTextAreaElement>('#survey-own-task')!;
    ownTask.value = '界'.repeat(1366);
    ownTask.dispatchEvent(new Event('input'));
    button(screen.root, 'Review persona').click();
    screen.fixture.detectChanges();
    expect(posts(screen.fetchSpy)).toHaveLength(0);
    ownTask.value = 'Track delivery slots';
    ownTask.dispatchEvent(new Event('input'));
    button(screen.root, 'Draft documents').click();
    button(screen.root, 'Draft documents').click();
    button(screen.root, 'Draft documents').click();
    screen.fetchSpy.mockImplementation((url) => {
      if (url === '/api/onboarding/survey') return reply({ status: 'confirmed' });
      if (url === '/api/onboarding') return reply(progress([name, work, style, tasks]));
      return reply({ authenticated: true, user: { name: 'Alex' } });
    });
    button(screen.root, 'Review persona').click();
    await vi.waitFor(() => expect(posts(screen.fetchSpy)).toHaveLength(1));
    const rawBody: unknown = posts(screen.fetchSpy)[0]?.[1]?.body;
    if (typeof rawBody !== 'string') throw new Error('Missing save body');
    const decoded: unknown = JSON.parse(rawBody);
    const body = z.object({ answers: z.object({ step: z.literal(4),
      tasks: z.array(z.string()), ownTask: z.string().nullable() }) }).parse(decoded);
    expect(body.answers).toEqual({ step: 4, tasks: ['draft_documents'],
      ownTask: 'Track delivery slots' });
    expect(Object.keys(body.answers)).toEqual(['step', 'tasks', 'ownTask']);
  });

  it('resumes completed progress with the recorded time and honest persona availability', async () => {
    const { root, fixture, fetchSpy } = open(progress([name, work, style, tasks]));
    await show(root, fixture, 4);
    expect(root.querySelector('time')?.dateTime).toBe(tasks.time);
    expect(root.textContent).toContain('Persona review is not available yet');
    expect(root.querySelector('a[href="/account/assistant"]')).not.toBeNull();
    button(root, 'Back').click();
    await show(root, fixture, 3);
    button(root, 'Formal').click();
    button(root, 'Continue').click();
    fixture.detectChanges();
    expect(root.textContent).toContain('Save this style and review your tasks again?');
    expect(posts(fetchSpy)).toHaveLength(0);
  });

  for (const status of [401, 403]) {
    it(`clears style and task answers when a save returns ${status}`, async () => {
      const screen = open(progress([name, work, style]));
      await show(screen.root, screen.fixture, 4);
      const field = screen.root.querySelector<HTMLTextAreaElement>('#survey-own-task')!;
      field.value = 'Private task';
      field.dispatchEvent(new Event('input'));
      screen.fetchSpy.mockImplementation((url) => {
        if (url === '/api/onboarding/survey') return reply({ status: 'refused' }, status);
        return reply({ authenticated: true, user: { name: 'Alex' } });
      });
      button(screen.root, 'Review persona').click();
      await vi.waitFor(() => {
        screen.fixture.detectChanges();
        expect(screen.root.querySelector('#survey-own-task')).toBeNull();
      });
      expect(screen.root.textContent).not.toContain('Private task');
      expect(screen.root.textContent).not.toContain('Teaching');
    });
  }
});
