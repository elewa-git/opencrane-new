import {
  ChangeDetectionStrategy, Component, ElementRef, input, signal, viewChild,
  type OnDestroy, type OnInit,
} from '@angular/core';
import { GrainLoader } from '../ui/grain-loader';
import { checkTimeLabel } from './group-wording';
import { fetchMember, fetchMemberAccess, type Access, type Detail, type Header,
  type ReadResult } from './members-api';

type ScreenState = 'loading' | 'ready' | 'failed' | 'missing' | 'access';
type AccessState = 'idle' | 'loading' | 'ready' | 'failed';
type Row = Access['rows'][number];
type Source = Row['sources'][number];
type Check = Row['eligibility']['person'];

@Component({
  selector: 'oc-member-detail-screen',
  imports: [GrainLoader],
  templateUrl: './member-detail-screen.html',
  styleUrls: ['./people.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MemberDetailScreen implements OnInit, OnDestroy {
  readonly memberId = input.required<string>();
  protected readonly member = signal<Header | Detail | undefined>(undefined);
  protected readonly detail = signal<Detail | undefined>(undefined);
  protected readonly access = signal<Access | undefined>(undefined);
  protected readonly state = signal<ScreenState>('loading');
  protected readonly accessState = signal<AccessState>('idle');
  protected readonly loadedAt = signal<string | undefined>(undefined);
  protected readonly denialStatus = signal<number | undefined>(undefined);
  protected readonly checkLabel = checkLabel;
  protected readonly sectionLabel = sectionLabel;
  protected readonly sourceLabel = sourceLabel;
  protected readonly groupSource = groupSource;
  private readonly request = new AbortController();
  private readonly accessHeading = viewChild<ElementRef<HTMLElement>>('accessHeading');
  private generation = 0;
  private focusTimer: number | undefined;

  ngOnInit(): void { void this.refresh(); }
  ngOnDestroy(): void {
    this.generation += 1;
    this.request.abort();
    if (this.focusTimer !== undefined) clearTimeout(this.focusTimer);
  }

  protected name(): string {
    return this.member()?.displayName || 'Member';
  }

  protected joinedDate(): string {
    const joinedAt = this.detail()?.joinedAt;
    if (!joinedAt) return '';
    const options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric',
      timeZone: 'UTC' };
    return new Date(joinedAt).toLocaleDateString('en-GB', options);
  }

  protected loadedTime(): string {
    const loadedAt = this.loadedAt();
    return loadedAt ? `${checkTimeLabel(loadedAt)} UTC` : '';
  }

  protected assistantName(assistantId: string): string {
    const rows = this.access()?.rows ?? [];
    for (const row of rows) {
      if (row.resourceType === 'assistant' && row.resourceId === assistantId) {
        return row.label || row.resourceId;
      }
    }
    return assistantId;
  }

  protected async refresh(): Promise<void> {
    if (this.state() === 'access' || this.request.signal.aborted) return;
    const generation = ++this.generation;
    this.state.set('loading');
    const result = await fetchMember(this.memberId(), this.request.signal);
    if (this.request.signal.aborted) return;
    if (result.kind === 'denied') {
      this.clearForAccessLoss(result.status);
      return;
    }
    if (generation !== this.generation) return;
    if (result.kind !== 'ok') {
      this.memberFailure(result);
      return;
    }
    this.member.set(result.value);
    if (!('email' in result.value)) {
      this.detail.set(undefined);
      this.access.set(undefined);
      this.accessState.set('idle');
      this.loadedAt.set(new Date().toISOString());
      this.state.set('ready');
      return;
    }
    this.detail.set(result.value);
    this.loadedAt.set(new Date().toISOString());
    this.state.set('ready');
    this.accessState.set('loading');
    await this.readAccess(generation);
  }

  private memberFailure(result: ReadResult<Header | Detail>): void {
    if (result.kind === 'missing') {
      this.member.set(undefined);
      this.detail.set(undefined);
      this.access.set(undefined);
      this.loadedAt.set(undefined);
      this.state.set('missing');
      return;
    }
    this.state.set('failed');
  }

  private async readAccess(generation: number): Promise<void> {
    const result = await fetchMemberAccess(this.memberId(), this.request.signal);
    if (this.request.signal.aborted) return;
    // A refusal from any live read withdraws old detail, even if a newer read succeeded.
    if (result.kind === 'denied') {
      this.clearForAccessLoss(result.status);
      return;
    }
    if (generation !== this.generation) return;
    if (result.kind !== 'ok') {
      this.accessState.set('failed');
      return;
    }
    this.access.set(result.value);
    this.accessState.set('ready');
  }

  private clearForAccessLoss(status: number): void {
    this.generation += 1;
    this.request.abort();
    this.member.set(undefined);
    this.detail.set(undefined);
    this.access.set(undefined);
    this.loadedAt.set(undefined);
    this.denialStatus.set(status);
    this.accessState.set('idle');
    this.state.set('access');
    this.focusTimer = globalThis.setTimeout(() => this.accessHeading()?.nativeElement.focus(), 0);
  }
}

function checkLabel(check: Check): string {
  if (check === 'allowed') return 'Allowed';
  if (check === 'denied') return 'Not allowed';
  return "Couldn't check";
}

function groupSource(source: Detail['groups'][number]): string {
  return source.membershipSource === 'local' ? 'Added here' : 'From identity provider';
}

function sourceLabel(source: Source): string {
  if (source.kind === 'direct') return 'Direct grant';
  if (source.kind === 'assistant') return 'Assistant grant';
  return `Via ${source.groupName || source.groupId || 'a group'}`;
}

const sectionWords: Record<string, string> = {
  grants: 'Some grants could not be checked',
  group_membership: 'Some group memberships could not be checked',
  unsupported_grants: 'Some older grants could not be checked',
  unsupported_ownership: 'Some assistant owners could not be checked',
  inventory_index: 'The access list is still catching up',
  inventory_limits: 'The access list is too large to check fully',
  retained_content: 'Some saved content is still catching up',
  changed_inventory: 'Access changed during this read',
  permissions: 'Some permission checks were unavailable',
  tool_policy: 'Some tool settings could not be read',
  tool_limits: 'There are more tools than this list can show',
};

function sectionLabel(code: string): string {
  return sectionWords[code] ?? 'Another part of access could not be checked';
}
