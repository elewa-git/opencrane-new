import { TestBed } from '@angular/core/testing';
import { z } from 'zod';
import { WelcomeChat } from './welcome-chat';

const active = { status: 'welcome_active', welcomeId: 'welcome-one',
  scriptVersion: 'welcome-v1', variant: 'assistant', revision: 2,
  revisionId: 'revision-two', generation: 1, position: 8, answered: 0,
  nextStep: 'weekly_help', question: 'What would make this week easier?', answer: null,
  startedAt: '2026-10-14T09:02:00.000Z', completedAt: null,
  assignmentStatus: 'assigned' };

function reply(value: unknown, status = 200): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(value), { status }));
}

function mount(read: (url: string, init?: RequestInit) => Promise<Response>) {
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
    const address = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    return read(address, init);
  });
  TestBed.configureTestingModule({ imports: [WelcomeChat] });
  const fixture = TestBed.createComponent(WelcomeChat);
  fixture.detectChanges();
  const root: unknown = fixture.nativeElement;
  if (!(root instanceof HTMLElement)) throw new Error('Missing welcome page');
  return { fixture, root, fetchSpy };
}

function commandBody(init?: RequestInit) {
  if (typeof init?.body !== 'string') throw new Error('Missing command body');
  const body: unknown = JSON.parse(init.body);
  return z.object({ commandId: z.string(), operation: z.string(),
    welcomeId: z.string().optional(), scriptVersion: z.string(),
    stepId: z.string().optional(), stepNumber: z.number().optional(),
    expectedPosition: z.number() }).parse(body);
}

async function show(screen: ReturnType<typeof mount>, words: string): Promise<void> {
  await vi.waitFor(() => {
    screen.fixture.detectChanges();
    expect(screen.root.textContent).toContain(words);
  });
}

describe('saved welcome chat', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  it('shows the saved script question and sends one ordered answer on duplicate clicks', async () => {
    let posts = 0;
    const screen = mount((url, init) => {
      if (url === '/api/onboarding/welcome' && init?.method === 'POST') {
        posts += 1;
        const body = commandBody(init);
        expect(body).toMatchObject({ operation: 'answer',
          welcomeId: 'welcome-one', scriptVersion: 'welcome-v1', stepId: 'weekly_help',
          stepNumber: 1, expectedPosition: 8 });
        return reply({ status: 'completion_pending', operation: 'onboarding.welcome_answer_recorded',
          commandId: body.commandId });
      }
      if (posts > 0) return reply({ ...active, status: 'completion_pending', answered: 1,
        nextStep: null, question: null, answer: 'A concise comparison of our two suppliers.' });
      return reply(active);
    });
    await show(screen, active.question);
    const answer = screen.root.querySelector('textarea')!;
    answer.value = 'A concise comparison of our two suppliers.';
    answer.dispatchEvent(new Event('input'));
    screen.fixture.detectChanges();
    const send = screen.root.querySelector('button[type="submit"]');
    if (!(send instanceof HTMLButtonElement)) throw new Error('Missing send button');
    send.click();
    send.click();
    await show(screen, 'Checking completion');
    expect(posts).toBe(1);
  });

  it('uses the welcome read to choose a start when the chat projection has not caught up',
    async () => {
      const requests: string[] = [];
      const screen = mount((url) => {
        requests.push(url);
        if (url === '/api/onboarding/welcome') {
          return reply({ status: 'not_started', nextStep: null, answered: 0,
            assistantAssigned: true });
        }
        return reply({}, 404);
      });
      await show(screen, 'Continue with your assistant');
      expect(screen.root.textContent).not.toContain('Continue without an assistant');
      expect(requests).toEqual(['/api/onboarding/welcome']);
    });

  it('marks a saved active question as resumed after a fresh page load', async () => {
    const screen = mount(() => reply(active));
    await show(screen, active.question);
    expect(screen.root.textContent).toContain('Welcome back');
    const notice = screen.root.querySelector('.resume-notice');
    const question = screen.root.querySelector('.assistant-row');
    expect(notice).not.toBeNull();
    expect(question).not.toBeNull();
    expect(notice!.compareDocumentPosition(question!) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
  });

  it('checks an unknown outcome by its original command without sending again', async () => {
    let posts = 0;
    let checked = '';
    const screen = mount((url, init) => {
      if (init?.method === 'POST') { posts += 1; return reply({ status: 'unknown' }, 503); }
      if (url.startsWith('/api/personal/changes/')) {
        checked = url;
        return reply({ status: 'unknown' }, 503);
      }
      return reply(active);
    });
    await show(screen, active.question);
    const answer = screen.root.querySelector('textarea')!;
    answer.value = 'Help with planning';
    answer.dispatchEvent(new Event('input'));
    screen.fixture.detectChanges();
    const send = screen.root.querySelector('button[type="submit"]');
    if (!(send instanceof HTMLButtonElement)) throw new Error('Missing send button');
    send.click();
    await show(screen, 'Check status');
    expect(screen.root.querySelector('textarea')).toBeNull();
    (Array.from(screen.root.querySelectorAll('button'))
      .find(button => button.textContent?.includes('Check status'))!).click();
    await vi.waitFor(() => expect(checked).toMatch(/^\/api\/personal\/changes\//));
    expect(posts).toBe(1);
  });

  it('keeps a completed welcome read-only after reload, even when archived', async () => {
    const complete = { ...active, status: 'completed', answered: 1, nextStep: null,
      question: null, answer: 'Saved private answer',
      completedAt: '2026-10-14T09:03:00.000Z' };
    const screen = mount(() => reply(complete));
    await show(screen, 'Saved private answer');
    expect(screen.root.textContent).toContain('Welcome complete');
    expect(screen.root.textContent).toContain('09:03');
    expect(screen.root.querySelector('textarea')).toBeNull();
    expect(screen.root.textContent).toContain('read-only');
  });

  it('clears private words when access is denied after an earlier read', async () => {
    let reads = 0;
    const screen = mount((url, init) => {
      if (init?.method === 'POST') return reply({ status: 'conflict' }, 409);
      if (url === '/api/onboarding/welcome') {
        reads += 1;
        return reads === 1 ? reply(active) : reply({ status: 'refused' }, 403);
      }
      return reply({}, 404);
    });
    await show(screen, active.question);
    const answer = screen.root.querySelector('textarea')!;
    answer.value = 'Private words';
    answer.dispatchEvent(new Event('input'));
    screen.fixture.detectChanges();
    const send = screen.root.querySelector('button[type="submit"]');
    if (!(send instanceof HTMLButtonElement)) throw new Error('Missing send button');
    send.click();
    await show(screen, 'access has changed');
    expect(screen.root.textContent).not.toContain('Private words');
    expect(screen.root.textContent).not.toContain(active.question);
  });

  it('requires fresh review after a competing answer changes saved progress', async () => {
    let reads = 0;
    const screen = mount((url, init) => {
      if (init?.method === 'POST') return reply({ status: 'conflict' }, 409);
      if (url === '/api/onboarding/welcome') {
        reads += 1;
        return reply(reads === 1 ? active : { ...active, status: 'completed',
          answered: 1, answer: 'A newer saved answer', nextStep: null,
          question: null, completedAt: '2026-10-14T09:03:00.000Z' });
      }
      return reply({}, 404);
    });
    await show(screen, active.question);
    const answer = screen.root.querySelector('textarea')!;
    answer.value = 'Old draft';
    answer.dispatchEvent(new Event('input'));
    screen.fixture.detectChanges();
    const send = screen.root.querySelector('button[type="submit"]');
    if (!(send instanceof HTMLButtonElement)) throw new Error('Missing send button');
    send.click();
    await show(screen, 'Review saved welcome');
    expect(screen.root.textContent).not.toContain('Old draft');
    expect(screen.root.querySelector('textarea')).toBeNull();
  });

  it('offers direct and group drafts after no-assistant completion', async () => {
    const noAssistant = { ...active, status: 'completed', variant: 'no_assistant',
      assignmentStatus: 'not_requested', answered: 1, nextStep: null,
      question: null, answer: 'Continue to workspace',
      completedAt: '2026-10-14T09:03:00.000Z' };
    const screen = mount(() => reply(noAssistant));
    await show(screen, 'Start a direct or group chat');
    expect(screen.root.querySelector('a[href="/workspace/direct"]')).not.toBeNull();
    expect(screen.root.querySelector('a[href="/workspace"]')).toBeNull();
    expect(screen.root.querySelector('textarea')).toBeNull();
  });
});
