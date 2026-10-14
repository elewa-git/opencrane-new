import { ChangeDetectionStrategy, Component, signal, type OnDestroy, type OnInit } from '@angular/core';
import { memberDirectorySchema } from '@opencrane/protocol';
import { SharedState } from '../shared-state/shared-state';
import { GrainLoader } from '../ui/grain-loader';
import { checkTimeLabel } from './group-wording';
import { classifyStatus } from './groups-api';

type Directory = ReturnType<typeof memberDirectorySchema.parse>;
type Member = Directory['rows'][number];
type State = 'loading' | 'ready' | 'failed' | 'access';

@Component({
  selector: 'oc-members-list',
  imports: [SharedState, GrainLoader],
  templateUrl: './members-list.html',
  styleUrls: ['./people.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MembersList implements OnInit, OnDestroy {
  protected readonly rows = signal<Member[]>([]);
  protected readonly state = signal<State>('loading');
  protected readonly search = signal('');
  protected readonly next = signal<string | null>(null);
  protected readonly loadedAt = signal<string | undefined>(undefined);
  protected readonly loadingMore = signal(false);
  protected readonly count = signal<number | undefined>(undefined);
  private readonly request = new AbortController();
  private generation = 0;
  private readInFlight = false;

  ngOnInit(): void { void this.load(''); }
  ngOnDestroy(): void {
    this.generation += 1;
    this.request.abort();
  }

  protected searchChanged(event: Event): void {
    const field = event.target;
    if (!(field instanceof HTMLInputElement)) return;
    const query = field.value.slice(0, 100);
    this.search.set(query);
    this.generation += 1;
    this.readInFlight = false;
    this.rows.set([]);
    this.next.set(null);
    this.count.set(undefined);
    this.loadedAt.set(undefined);
    void this.load('');
  }

  protected clearSearch(field: HTMLInputElement): void {
    field.value = '';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.focus();
  }

  protected refresh(): void {
    if (this.readInFlight || this.state() === 'access') return;
    this.next.set(null);
    void this.load('');
  }

  protected loadMore(): void {
    const cursor = this.next();
    if (!cursor || this.readInFlight || this.state() !== 'ready') return;
    void this.load(cursor);
  }

  protected loadedTime(): string {
    const value = this.loadedAt();
    return value ? `${checkTimeLabel(value)} UTC` : '';
  }

  protected memberName(member: Member): string {
    return member.displayName || member.email;
  }

  protected groupNames(member: Member): string {
    if (member.groups.length === 0) return 'No groups';
    const names = member.groups.map(groupName);
    return names.join(', ');
  }

  private async load(after: string): Promise<void> {
    if (this.readInFlight || this.request.signal.aborted || this.state() === 'access') return;
    this.readInFlight = true;
    const generation = this.generation;
    if (after) this.loadingMore.set(true);
    else this.state.set('loading');
    const parameters = new URLSearchParams({ q: this.search(), after, limit: '20' });
    const result = await this.read(`/api/members?${parameters.toString()}`);
    if (generation !== this.generation || this.request.signal.aborted) return;
    this.readInFlight = false;
    this.loadingMore.set(false);
    if (result.kind === 'access') {
      this.clearForAccessChange();
      return;
    }
    if (result.kind === 'failed') {
      this.state.set('failed');
      return;
    }
    const directory = result.value;
    if (after) {
      const known = new Set(this.rows().map(memberId));
      const additional: Member[] = [];
      for (const member of directory.rows) {
        if (!known.has(member.memberId)) additional.push(member);
      }
      this.rows.set([...this.rows(), ...additional]);
    } else {
      this.rows.set(directory.rows);
    }
    this.next.set(directory.next);
    this.count.set(directory.counts.members.status === 'current'
      ? directory.counts.members.value ?? undefined : undefined);
    this.loadedAt.set(new Date().toISOString());
    this.state.set('ready');
  }

  private async read(url: string): Promise<{ kind: 'ok'; value: Directory }
    | { kind: 'failed' } | { kind: 'access' }> {
    try {
      const response = await fetch(url, { headers: { accept: 'application/json' },
        signal: this.request.signal });
      if (!response.ok) {
        const kind = classifyStatus(response.status, 'GET');
        if (kind === 'access_changed') return { kind: 'access' };
        return { kind: 'failed' };
      }
      const raw: unknown = await response.json();
      const parsed = memberDirectorySchema.safeParse(raw);
      if (!parsed.success) return { kind: 'failed' };
      return { kind: 'ok', value: parsed.data };
    } catch {
      return { kind: 'failed' };
    }
  }

  private clearForAccessChange(): void {
    // Stop older replies from showing names after the server withdraws access.
    this.generation += 1;
    this.rows.set([]);
    this.search.set('');
    this.next.set(null);
    this.count.set(undefined);
    this.loadedAt.set(undefined);
    this.state.set('access');
  }
}

function memberId(member: Member): string { return member.memberId; }
function groupName(group: Member['groups'][number]): string { return group.name; }
