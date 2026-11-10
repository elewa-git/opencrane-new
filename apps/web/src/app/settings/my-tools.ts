import {
  ChangeDetectionStrategy, Component, ElementRef, input, signal, ViewChild,
  type OnDestroy, type OnInit,
} from '@angular/core';
import { z } from 'zod';

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u);
const profileSchema = z.object({
  serverId: identifier,
  profileId: identifier,
  profileRevision: z.number().int().positive(),
  status: z.enum(['saved_unverified', 'unavailable']),
  generation: z.number().int().positive().nullable(),
  adminBlocked: z.boolean(),
  serverAvailable: z.boolean(),
  callsAvailable: z.literal(false),
});
const rowSchema = profileSchema.extend({
  ownerKind: z.literal('personal'),
  selected: z.boolean(),
});
const listSchema = z.object({
  rows: z.array(rowSchema),
  next: z.string().nullable(),
  complete: z.boolean(),
});
const changeSchema = z.object({
  status: z.literal('confirmed'),
  changeRef: identifier,
  action: z.literal('revoke'),
  eventType: z.literal('connection.revoked'),
});
const revokeSchema = z.object({
  status: z.literal('revoked'),
  changeRef: identifier,
  sequence: z.number().int().positive(),
});
type Row = z.infer<typeof rowSchema>;
type Detail = z.infer<typeof profileSchema>;
type LoadState = 'loading' | 'ready' | 'failed' | 'access';

@Component({
  selector: 'oc-my-tools',
  templateUrl: './my-tools.html',
  styleUrl: './my-tools.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MyTools implements OnInit, OnDestroy {
  readonly serverId = input('');
  @ViewChild('review') private review?: ElementRef<HTMLDialogElement>;
  @ViewChild('reviewHeading') private reviewHeading?: ElementRef<HTMLHeadingElement>;
  protected readonly rows = signal<Row[]>([]);
  protected readonly next = signal<string | null>(null);
  protected readonly loadState = signal<LoadState>('loading');
  protected readonly search = signal('');
  protected readonly detail = signal<Detail | null>(null);
  protected readonly detailLoading = signal(false);
  protected readonly pendingReference = signal<string | null>(null);
  protected readonly outcome = signal('');
  protected readonly submitting = signal(false);
  protected readonly announcement = signal('');
  private request = new AbortController();
  private generation = 0;
  private reviewOpener?: HTMLElement;
  private pendingProfileId: string | null = null;

  ngOnInit(): void {
    if (this.validServerId()) {
      void this.load(false);
    } else {
      this.loadState.set('ready');
    }
  }

  protected validServerId(): boolean {
    return identifier.safeParse(this.serverId()).success;
  }

  ngOnDestroy(): void {
    this.generation += 1;
    this.request.abort();
    this.review?.nativeElement.close();
  }

  protected visibleRows(): Row[] {
    const query = this.search().trim().toLocaleLowerCase('en-GB');
    if (!query) return this.rows();
    const matching: Row[] = [];
    for (const row of this.rows()) {
      if (row.profileId.toLocaleLowerCase('en-GB').includes(query)) matching.push(row);
    }
    return matching;
  }

  protected searchChanged(event: Event): void {
    const target = event.target;
    if (target instanceof HTMLInputElement) this.search.set(target.value);
  }

  protected refresh(): void {
    if (this.loadState() === 'loading' || !this.validServerId()) return;
    void this.load(false);
  }

  protected more(): void {
    if (this.next()) void this.load(true);
  }

  private listUrl(cursor: string | null): string {
    const base = `/api/my/tools/${encodeURIComponent(this.serverId())}/profiles?limit=20`;
    if (!cursor) return base;
    return `${base}&cursor=${encodeURIComponent(cursor)}`;
  }

  private async load(more: boolean): Promise<void> {
    const cursor = more ? this.next() : null;
    this.loadState.set('loading');
    const current = this.generation;
    try {
      const reply = await fetch(this.listUrl(cursor), {
        cache: 'no-store', signal: this.request.signal,
      });
      if (this.accessRefused(reply)) return;
      if (!reply.ok) throw new Error('List unavailable');
      const body: unknown = await reply.json();
      if (current !== this.generation) return;
      const page = listSchema.parse(body);
      if (more) this.rows.set([...this.rows(), ...page.rows]);
      else this.rows.set(page.rows);
      this.next.set(page.next);
      this.loadState.set('ready');
      this.announcement.set('Your saved connections loaded.');
    } catch {
      if (current !== this.generation) return;
      this.loadState.set('failed');
      this.announcement.set("We couldn't refresh your connections.");
    }
  }

  private accessRefused(reply: Response): boolean {
    if (reply.status !== 401 && reply.status !== 403) return false;
    // Clear every checked value before another in-flight reply can use it.
    this.generation += 1;
    this.request.abort();
    this.rows.set([]);
    this.next.set(null);
    this.detail.set(null);
    this.pendingReference.set(null);
    this.pendingProfileId = null;
    this.review?.nativeElement.close();
    this.loadState.set('access');
    this.announcement.set('Access changed. Connection details were cleared.');
    return true;
  }

  protected async openDetail(row: Row): Promise<void> {
    this.detail.set(null);
    this.detailLoading.set(true);
    const current = this.generation;
    try {
      const reply = await fetch(this.profileUrl(row.profileId), {
        cache: 'no-store', signal: this.request.signal,
      });
      if (this.accessRefused(reply)) return;
      if (!reply.ok) throw new Error('Detail unavailable');
      const body: unknown = await reply.json();
      if (current !== this.generation) return;
      this.detail.set(profileSchema.parse(body));
    } catch {
      if (current === this.generation) this.outcome.set("We couldn't load this profile.");
    } finally {
      if (current === this.generation) this.detailLoading.set(false);
    }
  }

  private profileUrl(profileId: string): string {
    const server = encodeURIComponent(this.serverId());
    const profile = encodeURIComponent(profileId);
    return `/api/my/tools/${server}/profiles/${profile}`;
  }

  protected reviewRevoke(event: Event): void {
    if (!this.detail() || this.pendingReference()) return;
    const opener = event.currentTarget;
    if (opener instanceof HTMLElement) this.reviewOpener = opener;
    this.review?.nativeElement.showModal();
    this.reviewHeading?.nativeElement.focus();
  }

  protected cancelReview(): void {
    this.review?.nativeElement.close();
    this.reviewOpener?.focus();
  }

  protected async revoke(): Promise<void> {
    const profile = this.detail();
    if (!profile || this.submitting() || this.pendingReference()) return;
    const changeRef = crypto.randomUUID();
    this.pendingReference.set(changeRef);
    this.pendingProfileId = profile.profileId;
    this.submitting.set(true);
    this.review?.nativeElement.close();
    const current = this.generation;
    try {
      const reply = await fetch(`${this.profileUrl(profile.profileId)}/revoke`, {
        method: 'POST', cache: 'no-store', signal: this.request.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ changeRef, expectedSequence: profile.profileRevision }),
      });
      if (this.accessRefused(reply)) return;
      if (!reply.ok) throw new Error('Revoke outcome unknown');
      const body: unknown = await reply.json();
      if (current !== this.generation) return;
      const receipt = revokeSchema.parse(body);
      if (receipt.changeRef !== changeRef) throw new Error('Wrong change');
      this.outcome.set('Connection revoked here. Revoke the token at the provider too.');
      this.pendingReference.set(null);
      this.pendingProfileId = null;
      await this.openDetailById(profile.profileId);
      void this.load(false);
    } catch {
      if (current !== this.generation) return;
      this.outcome.set('Outcome unknown. Check the original change before any new action.');
    } finally {
      if (current === this.generation) this.submitting.set(false);
    }
  }

  private async openDetailById(profileId: string): Promise<void> {
    for (const row of this.rows()) {
      if (row.profileId === profileId) {
        await this.openDetail(row);
        return;
      }
    }
  }

  protected async checkStatus(): Promise<void> {
    const profileId = this.pendingProfileId;
    const changeRef = this.pendingReference();
    if (!profileId || !changeRef || this.submitting()) return;
    this.submitting.set(true);
    const current = this.generation;
    try {
      const url = `${this.profileUrl(profileId)}/changes/${encodeURIComponent(changeRef)}`;
      const reply = await fetch(url, { cache: 'no-store', signal: this.request.signal });
      if (this.accessRefused(reply)) return;
      if (reply.status === 404) {
        this.outcome.set('Still unknown. The original change has not been confirmed.');
        return;
      }
      if (!reply.ok) throw new Error('Status unavailable');
      const body: unknown = await reply.json();
      if (current !== this.generation) return;
      const change = changeSchema.parse(body);
      if (change.changeRef !== changeRef) throw new Error('Wrong change');
      this.pendingReference.set(null);
      this.pendingProfileId = null;
      this.outcome.set('Connection revoked here. Revoke the token at the provider too.');
      await this.openDetailById(profileId);
      void this.load(false);
    } catch {
      if (current === this.generation) this.outcome.set('Still unknown. Check again later.');
    } finally {
      if (current === this.generation) this.submitting.set(false);
    }
  }

  protected status(row: Row | Detail): string {
    if (row.adminBlocked && row.status === 'unavailable') {
      return 'Revoked or unavailable; disabled by an administrator';
    }
    if (row.adminBlocked) return 'Disabled by an administrator';
    if (row.status === 'unavailable') return 'Revoked or unavailable';
    if (!row.serverAvailable) return 'Server unavailable';
    return 'Saved, identity unverified';
  }
}
