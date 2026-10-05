import {
  ChangeDetectionStrategy, Component, input, signal, type OnDestroy, type OnInit,
} from '@angular/core';
import type { GroupRow } from '@opencrane/protocol';
import { SharedState, type PresentationState } from '../shared-state/shared-state';
import { GrainLoader } from '../ui/grain-loader';
import { fetchGroup, type Outcome } from './groups-api';
import { GroupDetail } from './group-detail';

type ScreenState = 'loading' | 'ready' | 'missing' | 'failed' | 'access';

@Component({ selector: 'oc-group-detail-screen', imports: [SharedState, GroupDetail, GrainLoader],
  templateUrl: './group-detail-screen.html', styleUrls: ['./people.css'],
  changeDetection: ChangeDetectionStrategy.OnPush })
export class GroupDetailScreen implements OnInit, OnDestroy {
  readonly groupId = input.required<string>();
  protected readonly group = signal<GroupRow | undefined>(undefined);
  protected readonly state = signal<ScreenState>('loading');
  protected readonly statusKind = signal<PresentationState>('checking');
  protected readonly statusMessage = signal('Loading group…');
  protected readonly detail = signal('');
  private accessStatus = 403;
  private readonly request = new AbortController();
  private readInFlight = false;

  ngOnInit(): void { void this.load(); }
  ngOnDestroy(): void { this.request.abort(); }

  protected async refresh(): Promise<void> { await this.load(); }

  protected heading(): string {
    if (this.state() === 'access') return 'Group details';
    if (this.state() === 'missing') return 'Group not found';
    return this.group()?.name ?? 'Group details';
  }

  protected async load(): Promise<void> {
    if (this.readInFlight || this.request.signal.aborted) return;
    this.readInFlight = true;
    this.state.set('loading');
    this.statusKind.set('checking');
    this.statusMessage.set('Loading group…');
    const result = await fetchGroup(this.groupId(), this.request.signal);
    this.readInFlight = false;
    if (this.request.signal.aborted) return;
    this.accept(result);
  }

  private accept(result: Outcome<GroupRow | undefined>): void {
    if (result.kind === 'ok') {
      this.group.set(result.value);
      if (!result.value) {
        this.state.set('missing');
        this.statusKind.set('removed');
        this.statusMessage.set("This group doesn't exist or is no longer available.");
        return;
      }
      this.state.set('ready');
      this.statusMessage.set('Group loaded');
      return;
    }
    if (result.kind === 'access_changed') {
      this.clearForAccessChange(result.status);
      return;
    }
    this.group.set(undefined);
    this.state.set('failed');
    this.statusKind.set('failed');
    this.statusMessage.set('Groups are unavailable right now');
    this.detail.set('Nothing changed. Reading again is safe.');
  }

  private clearForAccessChange(status?: number): void {
    this.request.abort();
    this.group.set(undefined);
    this.state.set('access');
    this.statusKind.set('access_changed');
    this.statusMessage.set('Your access changed');
    this.accessStatus = status ?? 403;
    this.detail.set(this.accessStatus === 401
      ? 'Group details were cleared. Your session ended. Sign in again to continue.'
      : 'Group details were cleared. Managing groups needs the Owner or Admin role.');
  }
}
