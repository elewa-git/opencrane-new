import {
  ChangeDetectionStrategy, Component, ElementRef, input, output, signal, viewChild,
  type OnDestroy,
} from '@angular/core';
import type { GroupRow } from '@opencrane/protocol';
import { searchMembers, type MemberDirectory } from './member-search-api';

type Candidate = MemberDirectory['rows'][number];
type SearchState = 'idle' | 'loading' | 'ready' | 'failed';

@Component({
  selector: 'oc-group-add-panel',
  templateUrl: './group-add-panel.html',
  styleUrls: ['./group-add-panel.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GroupAddPanel implements OnDestroy {
  readonly group = input.required<GroupRow>();
  readonly pending = input(false);
  readonly addRequested = output<Candidate>();
  readonly accessLost = output<number>();
  protected readonly query = signal('');
  protected readonly rows = signal<Candidate[]>([]);
  protected readonly next = signal<string | null>(null);
  protected readonly state = signal<SearchState>('idle');
  protected readonly resultsVisible = signal(true);
  private readonly field = viewChild<ElementRef<HTMLInputElement>>('searchField');
  private readonly request = new AbortController();
  private generation = 0;
  private timer: number | undefined;
  private loading = false;

  focus(): void {
    this.focusField();
  }

  ngOnDestroy(): void {
    this.generation += 1;
    this.request.abort();
    if (this.timer !== undefined) globalThis.clearTimeout(this.timer);
  }

  protected changed(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    const query = target.value.slice(0, 100);
    target.value = query;
    this.query.set(query);
    this.rows.set([]);
    this.next.set(null);
    this.state.set('idle');
    this.resultsVisible.set(true);
    this.generation += 1;
    this.loading = false;
    if (this.timer !== undefined) globalThis.clearTimeout(this.timer);
    if (query.trim()) this.timer = globalThis.setTimeout(this.searchFirstPage.bind(this), 250);
  }

  protected escape(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    this.resultsVisible.set(false);
    this.focusField();
  }

  protected retry(): void {
    void this.read('');
  }

  protected showMore(): void {
    const cursor = this.next();
    if (!cursor || this.loading) return;
    void this.read(cursor);
  }

  protected add(member: Candidate): void {
    if (this.pending() || this.alreadyMember(member)) return;
    this.addRequested.emit(member);
  }

  protected alreadyMember(member: Candidate): boolean {
    for (const existing of this.group().members) {
      if (existing.memberId === member.memberId) return true;
    }
    return false;
  }

  protected name(member: Candidate): string {
    return member.displayName || member.email;
  }

  protected otherGroups(member: Candidate): string {
    const names: string[] = [];
    for (const group of member.groups) {
      if (group.groupId !== this.group().groupId) names.push(group.name);
    }
    return names.length ? names.join(', ') : 'No groups';
  }

  private focusField(): void {
    this.field()?.nativeElement.focus();
  }

  private searchFirstPage(): void {
    void this.read('');
  }

  private async read(after: string): Promise<void> {
    if (!this.query().trim() || this.request.signal.aborted || this.loading) return;
    this.loading = true;
    this.state.set('loading');
    const generation = this.generation;
    const result = await searchMembers(this.query().trim(), after, this.request.signal);
    if (this.request.signal.aborted) return;
    if (result.kind === 'access_changed') {
      this.rows.set([]);
      this.next.set(null);
      this.accessLost.emit(result.status ?? 403);
      return;
    }
    // Ignore old search replies, but honour an access denial from any live request.
    if (generation !== this.generation) return;
    this.loading = false;
    if (result.kind !== 'ok') {
      this.state.set('failed');
      return;
    }
    if (after) {
      const known = new Set(this.rows().map(memberId));
      const additional: Candidate[] = [];
      for (const member of result.value.rows) {
        if (known.has(member.memberId)) continue;
        known.add(member.memberId);
        additional.push(member);
      }
      this.rows.set([...this.rows(), ...additional]);
    } else {
      this.rows.set(result.value.rows);
    }
    this.next.set(result.value.next);
    this.state.set('ready');
  }
}

function memberId(member: Candidate): string { return member.memberId; }
