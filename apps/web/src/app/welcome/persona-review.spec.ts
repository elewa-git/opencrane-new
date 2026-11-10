import { TestBed } from '@angular/core/testing';
import { z } from 'zod';
import { PersonaReview } from './persona-review';

const steps = [1, 2, 3, 4].map(step => ({
  time: '2026-10-14T09:30:00.000Z', answers: { step },
}));
const revision = { revision: 2, revisionId: 'revision-two', generation: 1,
  current: true, replacement: 'Private saved persona r2', approved: false };

function progress(currentRevision: number | null = 2, position = 6, savedSteps = steps) {
  return { state: 'review', survey: { generation: 1, position, nextStep: null,
    steps: savedSteps },
    currentRevision, approval: null };
}

function reply(value: unknown, status = 200): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(value), { status }));
}

function parseCommandBody(init?: RequestInit): unknown {
  if (typeof init?.body !== 'string') throw new Error('Missing command body');
  return JSON.parse(init.body);
}

function deferredReply() {
  let finish: ((response: Response) => void) | undefined;
  const promise = new Promise<Response>(resolve => { finish = resolve; });
  return { promise, finish(response: Response) { finish?.(response); } };
}

function button(root: HTMLElement, label: string): HTMLButtonElement {
  const found = Array.from(root.querySelectorAll('button'))
    .find(candidate => candidate.textContent?.trim() === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

function open(read: (url: string, init?: RequestInit) => Promise<Response>,
  assistantAssigned = true) {
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
    const address = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    if (address === '/api/onboarding/welcome') {
      return reply({ status: 'not_started', assistantAssigned });
    }
    return read(address, init);
  });
  TestBed.configureTestingModule({ imports: [PersonaReview] });
  const fixture = TestBed.createComponent(PersonaReview);
  fixture.detectChanges();
  const root: unknown = fixture.nativeElement;
  if (!(root instanceof HTMLElement)) throw new Error('Missing persona review');
  return { root, fixture, fetchSpy };
}

async function show(screen: ReturnType<typeof open>, text: string) {
  await vi.waitFor(() => {
    screen.fixture.detectChanges();
    expect(screen.root.textContent).toContain(text);
  });
}

describe('saved persona review', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  it('saves an edited draft while the earlier approval stays active', async () => {
    let current = 2;
    let savedBody: unknown;
    const screen = open((url, init) => {
      if (url === '/api/onboarding') {
        return reply({ ...progress(current, current + 4), approval: {
          revision: 2, revisionId: 'revision-two', time: '2026-10-14T09:35:00.000Z',
        } });
      }
      if (url === '/api/onboarding/persona/revisions') {
        return reply({ currentRevision: current,
          revisions: [{ revision: current, revisionId: `revision-${current}` }] });
      }
      if (url.startsWith('/api/onboarding/persona/revisions/')) {
        return reply({ ...revision, revision: current, revisionId: `revision-${current}`,
          replacement: `Private saved persona r${current}` });
      }
      if (url === '/api/onboarding/persona' && init?.method === 'POST') {
        savedBody = parseCommandBody(init);
        current = 3;
        return reply({ status: 'confirmed', operation: 'onboarding.persona_revised',
          commandId: z.object({ commandId: z.string() }).parse(savedBody).commandId,
          revision: 3, revisionId: 'revision-3' });
      }
      return reply({}, 503);
    });
    await show(screen, 'Approved revision r2');
    button(screen.root, 'Edit').click();
    await show(screen, 'Save as new revision');
    const input = screen.root.querySelector('textarea');
    expect(input).not.toBeNull();
    input!.value = 'New private draft';
    input!.dispatchEvent(new Event('input'));
    button(screen.root, 'Save as new revision').click();
    await show(screen, 'Private saved persona r3');
    expect(screen.root.textContent).toContain('Approved revision r2');
    expect(screen.root.querySelector('a[href="/welcome"]')).not.toBeNull();
    expect(savedBody).toMatchObject({ operation: 'revise', mode: 'replace',
      replacement: 'New private draft', generation: 1, expectedPosition: 6 });
  });

  it('rejects an oversized multibyte edit without sending it', async () => {
    const screen = open((url) => {
      if (url === '/api/onboarding') return reply(progress());
      if (url === '/api/onboarding/persona/revisions') {
        return reply({ currentRevision: 2, revisions: [revision] });
      }
      return reply(revision);
    });
    await show(screen, revision.replacement);
    button(screen.root, 'Edit').click();
    await show(screen, 'Save as new revision');
    const input = screen.root.querySelector('textarea')!;
    input.value = '🙂'.repeat(1025);
    input.dispatchEvent(new Event('input'));
    button(screen.root, 'Save as new revision').click();
    await show(screen, 'Keep it under 4 KiB');
    input.value = '';
    input.dispatchEvent(new Event('input'));
    button(screen.root, 'Save as new revision').click();
    await show(screen, 'Enter persona text before saving');
    expect(screen.fetchSpy.mock.calls.filter(([url]) => url === '/api/onboarding/persona'))
      .toHaveLength(0);
  });

  it('asks before restart and cancel writes nothing', async () => {
    const screen = open((url) => {
      if (url === '/api/onboarding') return reply(progress());
      if (url === '/api/onboarding/persona/revisions') {
        return reply({ currentRevision: 2, revisions: [revision] });
      }
      return reply(revision);
    });
    await show(screen, revision.replacement);
    button(screen.root, 'Restart survey').click();
    await show(screen, 'Your answers in steps 1–4 will be replaced');
    button(screen.root, 'Cancel').click();
    await show(screen, revision.replacement);
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(screen.root.querySelector('#restart-open'));
    });
    button(screen.root, 'Restart survey').click();
    await show(screen, 'Restart the survey?');
    screen.root.querySelector('[role="dialog"]')?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await vi.waitFor(() => {
      screen.fixture.detectChanges();
      expect(document.activeElement).toBe(screen.root.querySelector('#restart-open'));
    });
    expect(screen.fetchSpy.mock.calls.filter(([url, init]) =>
      url === '/api/onboarding/survey' && init?.method === 'POST')).toHaveLength(0);
  });

  it('says no persona is approved when restarting from the first draft', async () => {
    const screen = open((url) => {
      if (url === '/api/onboarding') return reply(progress());
      if (url === '/api/onboarding/persona/revisions') {
        return reply({ currentRevision: 2, revisions: [revision] });
      }
      return reply(revision);
    });
    await show(screen, revision.replacement);
    button(screen.root, 'Restart survey').click();
    await show(screen, 'Restart the survey?');
    const dialog = screen.root.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('No persona is approved yet.');
    expect(dialog?.textContent).not.toContain('Approved revision r2 stays active');
  });

  it('keeps an unsaved edit beside the newer revision after a conflict', async () => {
    let current = 2;
    const screen = open((url, init) => {
      if (url === '/api/onboarding') return reply(progress(current, current + 4));
      if (url === '/api/onboarding/persona/revisions') {
        return reply({ currentRevision: current, revisions: [{ revision: current,
          revisionId: `revision-${current}` }] });
      }
      if (url.startsWith('/api/onboarding/persona/revisions/')) {
        return reply({ ...revision, revision: current, revisionId: `revision-${current}`,
          replacement: `Other device revision r${current}` });
      }
      if (url === '/api/onboarding/persona' && init?.method === 'POST') {
        current = 3;
        return reply({ status: 'conflict' }, 409);
      }
      return reply({}, 503);
    });
    await show(screen, 'Other device revision r2');
    button(screen.root, 'Edit').click();
    await show(screen, 'Save as new revision');
    const input = screen.root.querySelector('textarea');
    expect(input).not.toBeNull();
    input!.value = 'My unsaved words';
    input!.dispatchEvent(new Event('input'));
    button(screen.root, 'Save as new revision').click();
    await show(screen, 'Other device revision r3');
    expect(screen.root.querySelector('textarea')?.value).toBe('My unsaved words');
    expect(screen.root.querySelector('[role="dialog"]')?.textContent)
      .toContain('A newer revision exists');
    expect(button(screen.root, 'Review r3')).toBeDefined();
    expect(screen.fetchSpy.mock.calls.filter(([url]) => url === '/api/onboarding/persona'))
      .toHaveLength(1);
    button(screen.root, 'Review r3').click();
    await show(screen, 'Other device revision r3');
    button(screen.root, 'Edit').click();
    await show(screen, 'Save as new revision');
    expect(screen.root.querySelector('textarea')?.value).toBe('My unsaved words');
  });

  it('shows an unassigned member a truthful state without generating a persona', async () => {
    const screen = open((url) => {
      if (url === '/api/onboarding') return reply(progress(null));
      return reply({}, 503);
    }, false);
    await show(screen, 'No personal assistant is assigned');
    expect(screen.fetchSpy.mock.calls.filter(([url]) => url === '/api/onboarding/persona'))
      .toHaveLength(0);
  });

  it('restarts only after confirmation and keeps the earlier approval', async () => {
    let commandBody: unknown;
    const screen = open((url, init) => {
      if (url === '/api/onboarding') {
        return reply({ ...progress(), approval: { revision: 2,
          revisionId: 'revision-two', time: '2026-10-14T09:35:00.000Z' } });
      }
      if (url === '/api/onboarding/persona/revisions') {
        return reply({ currentRevision: 2, revisions: [revision] });
      }
      if (url === '/api/onboarding/survey' && init?.method === 'POST') {
        commandBody = parseCommandBody(init);
        const commandId = z.object({ commandId: z.string() }).parse(commandBody).commandId;
        return reply({ status: 'confirmed', operation: 'onboarding.survey_restarted', commandId });
      }
      return reply(revision);
    });
    await show(screen, 'Approved revision r2');
    button(screen.root, 'Restart survey').click();
    await show(screen, 'Your answers in steps 1–4 will be replaced');
    button(screen.root, 'Restart survey').click();
    await show(screen, 'Survey restarted');
    expect(commandBody).toMatchObject({ operation: 'restart', generation: 1,
      expectedPosition: 6 });
    expect(screen.root.textContent).toContain('approved revision stays active');
    expect(screen.root.querySelector('a[href="/welcome/survey"]')).not.toBeNull();
  });

  it('checks an uncertain edit with its original id and never sends it again', async () => {
    let commandId = '';
    let current = 2;
    const screen = open((url, init) => {
      if (url === '/api/onboarding') return reply(progress(current));
      if (url === '/api/onboarding/persona/revisions') {
        return reply({ currentRevision: current, revisions: [{ revision: current,
          revisionId: current === 2 ? 'revision-two' : 'revision-three' }] });
      }
      if (url.startsWith('/api/onboarding/persona/revisions/')) {
        return reply({ ...revision, revision: current,
          revisionId: current === 2 ? 'revision-two' : 'revision-three',
          replacement: `Private saved persona r${current}` });
      }
      if (url === '/api/onboarding/persona' && init?.method === 'POST') {
        commandId = z.object({ commandId: z.string() })
          .parse(parseCommandBody(init)).commandId;
        return reply({ status: 'unknown' }, 503);
      }
      if (url === `/api/personal/changes/${commandId}`) {
        current = 3;
        return reply({ status: 'confirmed', operation: 'onboarding.persona_revised',
          commandId, revision: 3, revisionId: 'revision-three' });
      }
      return reply({}, 503);
    });
    await show(screen, revision.replacement);
    button(screen.root, 'Edit').click();
    await show(screen, 'Save as new revision');
    button(screen.root, 'Save as new revision').click();
    await show(screen, 'Save status unknown');
    button(screen.root, 'Check status').click();
    await show(screen, 'Private saved persona r3');
    expect(screen.fetchSpy.mock.calls.filter(([url]) => url === '/api/onboarding/persona'))
      .toHaveLength(1);
  });

  it('loads the actual current revision after four saved steps', async () => {
    const screen = open((url) => {
      if (url === '/api/onboarding') return reply(progress());
      if (url === '/api/onboarding/persona/revisions') {
        return reply({ revisions: [{ revision: 2, revisionId: revision.revisionId }],
          currentRevision: 2 });
      }
      if (url.endsWith('/revision-two')) return reply(revision);
      return reply({ status: 'unavailable' }, 503);
    });
    await show(screen, revision.replacement);
    expect(screen.root.textContent).toContain('Revision r2');
    expect(button(screen.root, 'Approve this version').disabled).toBe(false);
  });

  it.each(['absent', 'loading', 'stale', 'denied'])(
    'never offers approval for a %s proposal', async state => {
      const pending = deferredReply();
      const screen = open((url) => {
        if (url === '/api/onboarding') {
          return reply(progress(state === 'absent' ? null : 2, 6,
            state === 'absent' ? steps.slice(0, 3) : steps));
        }
        if (url === '/api/onboarding/persona/revisions') {
          if (state === 'loading') return pending.promise;
          if (state === 'denied') return reply({ status: 'refused' }, 403);
          return reply({ revisions: [{ revision: 2, revisionId: revision.revisionId }],
            currentRevision: 2 });
        }
        return reply({ ...revision, current: false });
      });
      await show(screen, state === 'denied' ? 'Your access has changed'
        : state === 'absent' ? 'No persona yet'
          : state === 'loading' ? 'Checking your saved persona' : 'Proposal changed');
      expect(screen.root.querySelector('button.approve')).toBeNull();
      pending.finish(new Response());
    },
  );

  it('refuses r3 after another device saves r4, then reads r4 without approving it', async () => {
    let current = 3;
    const screen = open((url, init) => {
      if (url === '/api/onboarding') return reply(progress(current, current + 4));
      if (url === '/api/onboarding/persona/revisions') {
        return reply({ revisions: [{ revision: current, revisionId: `revision-${current}` }],
          currentRevision: current });
      }
      if (url.startsWith('/api/onboarding/persona/revisions/')) {
        return reply({ ...revision, revision: current, revisionId: `revision-${current}`,
          replacement: `Private saved persona r${current}` });
      }
      if (url === '/api/onboarding/persona' && init?.method === 'POST') {
        current = 4;
        return reply({ status: 'conflict' }, 409);
      }
      return reply({ status: 'unavailable' }, 503);
    });
    await show(screen, 'Private saved persona r3');
    button(screen.root, 'Approve this version').click();
    await show(screen, 'Private saved persona r4');
    expect(screen.root.textContent).toContain('Proposal changed');
    expect(screen.root.querySelector('a[href="/welcome"]')).toBeNull();
    expect(screen.fetchSpy.mock.calls.filter(([url]) => url === '/api/onboarding/persona'))
      .toHaveLength(1);
  });

  it('checks an unknown approval by its original command and offers welcome only when confirmed',
    async () => {
      let commandId = '';
      let confirmed = false;
      const screen = open((url, init) => {
        if (url === '/api/onboarding') return reply(progress());
        if (url === '/api/onboarding/persona/revisions') {
          return reply({ revisions: [{ revision: 2, revisionId: revision.revisionId }],
            currentRevision: 2 });
        }
        if (url.endsWith('/revision-two')) return reply(revision);
        if (url === '/api/onboarding/persona' && init?.method === 'POST') {
          if (typeof init.body !== 'string') throw new Error('Missing approval body');
          const body: unknown = JSON.parse(init.body);
          commandId = z.object({ commandId: z.string() }).parse(body).commandId;
          return reply({ status: 'unknown' }, 503);
        }
        if (url === `/api/personal/changes/${commandId}`) {
          confirmed = true;
          return reply({ status: 'confirmed', commandId, operation: 'onboarding.persona_approved',
            revision: 2, revisionId: revision.revisionId,
            time: '2026-10-14T09:35:00.000Z' });
        }
        return reply({ status: 'unavailable' }, 503);
      });
      await show(screen, revision.replacement);
      const approval = button(screen.root, 'Approve this version');
      approval.click();
      approval.click();
      await show(screen, 'Save status unknown');
      expect(screen.root.querySelector('a[href="/welcome"]')).toBeNull();
      button(screen.root, 'Check status').click();
      await show(screen, 'Approved revision r2');
      expect(confirmed).toBe(true);
      expect(screen.root.querySelector('a[href="/welcome"]')?.textContent)
        .toContain('Open welcome chat');
      expect(screen.root.querySelector('time')?.dateTime).toBe('2026-10-14T09:35:00.000Z');
      expect(screen.root.textContent).toContain('14 Oct 2026, 09:35 UTC');
      expect(screen.fetchSpy.mock.calls.filter(([url]) => url === '/api/onboarding/persona'))
        .toHaveLength(1);
    });

  it.each([401, 403])('clears text on a late %i and ignores older replies', async status => {
    const older = deferredReply();
    const screen = open((url) => {
      if (url === '/api/onboarding') return reply(progress());
      if (url === '/api/onboarding/persona/revisions') return reply({ revisions: [revision],
        currentRevision: 2 });
      if (url.endsWith('/revision-two')) return older.promise;
      return reply({ status: 'refused' }, status);
    });
    await show(screen, 'Checking your saved persona');
    older.finish(new Response(JSON.stringify(revision), { status }));
    await show(screen, status === 401 ? 'Your session has expired' : 'Your access has changed');
    expect(screen.root.textContent).not.toContain(revision.replacement);
    expect(screen.root.querySelector('button.approve')).toBeNull();
  });

  it('keeps a safe retry after a 503', async () => {
    let failed = true;
    const screen = open((url) => {
      if (url === '/api/onboarding') return reply(progress());
      if (url === '/api/onboarding/persona/revisions') {
        if (failed) return reply({ status: 'unavailable' }, 503);
        return reply({ revisions: [{ revision: 2, revisionId: revision.revisionId }],
          currentRevision: 2 });
      }
      return reply(revision);
    });
    await show(screen, 'Persona service unavailable');
    expect(screen.root.querySelector('button.approve')).toBeNull();
    failed = false;
    button(screen.root, 'Try again').click();
    await show(screen, revision.replacement);
  });

  it('generates the first revision after four saved steps and reads its saved text', async () => {
    let currentRevision: number | null = null;
    let commandBody: unknown;
    function read(url: string, init?: RequestInit): Promise<Response> {
      if (url === '/api/onboarding') return reply(progress(currentRevision, currentRevision ? 7 : 6));
      if (url === '/api/onboarding/persona' && init?.method === 'POST') {
        if (typeof init.body !== 'string') throw new Error('Missing generation body');
        commandBody = JSON.parse(init.body);
        currentRevision = 1;
        return reply({ status: 'confirmed', operation: 'onboarding.persona_revised',
          commandId: z.object({ commandId: z.string() }).parse(commandBody).commandId,
          revision: 1, revisionId: 'revision-one' });
      }
      if (url === '/api/onboarding/persona/revisions') {
        return reply({ currentRevision: 1,
          revisions: [{ revision: 1, revisionId: 'revision-one' }] });
      }
      if (url.endsWith('/revision-one')) {
        return reply({ ...revision, revision: 1, revisionId: 'revision-one',
          replacement: 'Generated private persona' });
      }
      return reply({ status: 'unavailable' }, 503);
    }
    const screen = open(read);
    await show(screen, 'Generated private persona');
    expect(commandBody).toMatchObject({ operation: 'revise', mode: 'generate',
      generation: 1, expectedPosition: 6 });
    expect(screen.fetchSpy.mock.calls.filter(([url]) => url === '/api/onboarding/persona'))
      .toHaveLength(1);
    expect(button(screen.root, 'Approve this version').disabled).toBe(false);
  });

  it('checks an uncertain first revision without sending another command', async () => {
    let currentRevision: number | null = null;
    let commandId = '';
    function read(url: string, init?: RequestInit): Promise<Response> {
      if (url === '/api/onboarding') return reply(progress(currentRevision));
      if (url === '/api/onboarding/persona' && init?.method === 'POST') {
        if (typeof init.body !== 'string') throw new Error('Missing generation body');
        const body = z.object({ commandId: z.string() }).parse(JSON.parse(init.body));
        commandId = body.commandId;
        return reply({ status: 'unknown' }, 503);
      }
      if (url === `/api/personal/changes/${commandId}`) {
        currentRevision = 1;
        return reply({ status: 'confirmed', operation: 'onboarding.persona_revised',
          commandId, revision: 1, revisionId: 'revision-one' });
      }
      if (url === '/api/onboarding/persona/revisions') {
        return reply({ currentRevision: 1,
          revisions: [{ revision: 1, revisionId: 'revision-one' }] });
      }
      if (url.endsWith('/revision-one')) {
        return reply({ ...revision, revision: 1, revisionId: 'revision-one' });
      }
      return reply({ status: 'unavailable' }, 503);
    }
    const screen = open(read);
    await show(screen, 'Creation status unknown');
    expect(screen.root.querySelector('button.approve')).toBeNull();
    button(screen.root, 'Check status').click();
    await show(screen, revision.replacement);
    expect(screen.fetchSpy.mock.calls.filter(([url]) => url === '/api/onboarding/persona'))
      .toHaveLength(1);
  });

  it('reloads after a first revision conflict without posting another revision', async () => {
    let currentRevision: number | null = null;
    function read(url: string, init?: RequestInit): Promise<Response> {
      if (url === '/api/onboarding') return reply(progress(currentRevision));
      if (url === '/api/onboarding/persona' && init?.method === 'POST') {
        currentRevision = 1;
        return reply({ status: 'conflict' }, 409);
      }
      if (url === '/api/onboarding/persona/revisions') {
        return reply({ currentRevision: 1,
          revisions: [{ revision: 1, revisionId: 'revision-one' }] });
      }
      if (url.endsWith('/revision-one')) {
        return reply({ ...revision, revision: 1, revisionId: 'revision-one',
          replacement: 'Other device persona' });
      }
      return reply({ status: 'unavailable' }, 503);
    }
    const screen = open(read);
    await show(screen, 'Other device persona');
    expect(screen.root.textContent).toContain('Proposal changed');
    expect(screen.fetchSpy.mock.calls.filter(([url]) => url === '/api/onboarding/persona'))
      .toHaveLength(1);
  });

  it('shows the saved approval time when opening an approved revision', async () => {
    const approved = { ...progress(), approval: { revision: 2,
      revisionId: revision.revisionId, time: '2026-10-14T09:35:00.000Z' } };
    function read(url: string): Promise<Response> {
      if (url === '/api/onboarding') return reply(approved);
      if (url === '/api/onboarding/persona/revisions') {
        return reply({ currentRevision: 2, revisions: [revision] });
      }
      return reply(revision);
    }
    const screen = open(read);
    await show(screen, 'Approved revision r2');
    expect(screen.root.querySelector('time')?.dateTime).toBe(approved.approval.time);
    expect(screen.root.textContent).toContain('14 Oct 2026, 09:35 UTC');
    expect(screen.root.querySelector('a[href="/welcome"]')?.textContent)
      .toContain('Open welcome chat');
  });
});
