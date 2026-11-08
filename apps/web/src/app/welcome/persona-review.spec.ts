import { TestBed } from '@angular/core/testing';
import { PersonaReview } from './persona-review';

const steps = [1, 2, 3, 4].map(step => ({
  time: '2026-10-14T09:30:00.000Z', answers: { step },
}));
const revision = { revision: 2, revisionId: 'revision-two', generation: 1,
  current: true, replacement: 'Private saved persona r2', approved: false };

function progress(currentRevision: number | null = 2, position = 6) {
  return { state: 'review', survey: { generation: 1, position, nextStep: null, steps },
    currentRevision, approval: null };
}

function reply(value: unknown, status = 200): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(value), { status }));
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

function open(read: (url: string, init?: RequestInit) => Promise<Response>) {
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) =>
    read(String(url), init));
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
          return reply(progress(state === 'absent' ? null : 2));
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

  it('refuses r2 after another device saves r3, then reads r3 without approving it', async () => {
    let current = 2;
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
        current = 3;
        return reply({ status: 'conflict' }, 409);
      }
      return reply({ status: 'unavailable' }, 503);
    });
    await show(screen, 'Private saved persona r2');
    button(screen.root, 'Approve this version').click();
    await show(screen, 'Private saved persona r3');
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
          commandId = JSON.parse(String(init.body)).commandId;
          return reply({ status: 'unknown' }, 503);
        }
        if (url === `/api/personal/changes/${commandId}`) {
          confirmed = true;
          return reply({ status: 'confirmed', commandId, operation: 'onboarding.persona_approved',
            revision: 2, revisionId: revision.revisionId });
        }
        return reply({ status: 'unavailable' }, 503);
      });
      await show(screen, revision.replacement);
      button(screen.root, 'Approve this version').click();
      await show(screen, 'Save status unknown');
      expect(screen.root.querySelector('a[href="/welcome"]')).toBeNull();
      button(screen.root, 'Check status').click();
      await show(screen, 'Approved revision r2');
      expect(confirmed).toBe(true);
      expect(screen.root.querySelector('a[href="/welcome"]')).not.toBeNull();
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
});
