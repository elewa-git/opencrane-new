import { TestBed } from '@angular/core/testing';
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
  const root = fixture.nativeElement as HTMLElement;
  return { fixture, root, fetchSpy };
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
        expect(JSON.parse(String(init.body))).toMatchObject({ operation: 'answer',
          welcomeId: 'welcome-one', scriptVersion: 'welcome-v1', stepId: 'weekly_help',
          stepNumber: 1, expectedPosition: 8 });
        return reply({ status: 'completion_pending', operation: 'onboarding.welcome_answer_recorded',
          commandId: JSON.parse(String(init.body)).commandId });
      }
      return reply(active);
    });
    await show(screen, active.question);
    const answer = screen.root.querySelector('textarea')!;
    answer.value = 'A concise comparison of our two suppliers.';
    answer.dispatchEvent(new Event('input'));
    screen.fixture.detectChanges();
    const send = screen.root.querySelector('button[type="submit"]')! as HTMLButtonElement;
    send.click();
    send.click();
    await show(screen, 'Checking completion');
    expect(posts).toBe(1);
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
    (screen.root.querySelector('button[type="submit"]') as HTMLButtonElement).click();
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
    (screen.root.querySelector('button[type="submit"]') as HTMLButtonElement).click();
    await show(screen, 'access has changed');
    expect(screen.root.textContent).not.toContain('Private words');
    expect(screen.root.textContent).not.toContain(active.question);
  });
});
