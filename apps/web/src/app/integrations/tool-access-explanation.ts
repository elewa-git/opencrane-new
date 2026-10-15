import { ChangeDetectionStrategy, Component, input, signal, type OnDestroy, type OnInit }
  from '@angular/core';
import { toolAccessExplanationSchema } from '@opencrane/protocol';
import type { z } from 'zod';

type Explanation = z.infer<typeof toolAccessExplanationSchema>;
type PageState = 'loading' | 'ready' | 'failed' | 'incomplete' | 'refused' | 'sign-in';
type Grant = Explanation['person'];
type Source = Extract<Explanation, { sources: unknown }>['sources'][number];

const idPattern = /^[\w-]{1,200}$/u;
const toolPattern = /^[A-Za-z0-9_.-]{1,100}$/u;
const reasonText: Record<string, string> = {
  missing_requester_grant: 'This person needs access to this integration.',
  missing_assistant_grant: 'This assistant needs access to this integration.',
  cannot_act_for_assistant: 'This assistant cannot act for this person.',
  iam_unavailable: "Access couldn't be checked.",
  publication_unavailable: 'Publishing is not available yet.',
  profile_not_available_yet: 'Personal accounts are not available on this version.',
  profile_unavailable: "The personal account couldn't be checked.",
  tool_not_found: "This tool couldn't be checked.",
  review_required: 'This tool needs review.',
  tool_blocked: 'This tool is blocked.',
  not_published: 'This integration is not published.',
  catalogue_not_current: "The tool list couldn't be confirmed as current.",
  inventory_unavailable: "Some access details couldn't be checked.",
};

@Component({
  selector: 'oc-tool-access-explanation',
  templateUrl: './tool-access-explanation.html',
  styleUrl: './tool-access-explanation.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ToolAccessExplanation implements OnInit, OnDestroy {
  readonly serverId = input.required<string>();
  protected readonly state = signal<PageState>('loading');
  protected readonly explanation = signal<Explanation | undefined>(undefined);
  protected readonly refreshing = signal(false);
  protected readonly failedRefresh = signal(false);
  protected readonly toolName = signal('');
  protected readonly requesterName = signal('This person');
  protected readonly assistantName = signal('Personal assistant');
  private readonly requests = new Set<AbortController>();
  private generation = 0;
  private accessLost = false;
  private destroyed = false;
  private requesterId = '';
  private assistantId = '';

  ngOnInit(): void {
    const query = new URLSearchParams(globalThis.location.search);
    const requesterId = query.get('requester');
    const assistantId = query.get('assistant');
    const toolName = query.get('tool');
    if (!requesterId || !assistantId || !toolName ||
        !idPattern.test(this.serverId()) || !idPattern.test(requesterId) ||
        !idPattern.test(assistantId) || !toolPattern.test(toolName) ||
        query.getAll('requester').length !== 1 ||
        query.getAll('assistant').length !== 1 || query.getAll('tool').length !== 1) {
      this.state.set('incomplete');
      return;
    }
    this.requesterId = requesterId;
    this.assistantId = assistantId;
    this.toolName.set(toolName);
    void this.read();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.abortReads();
  }

  protected retry(): void {
    if (this.refreshing() || this.accessLost) return;
    this.refreshing.set(true);
    this.failedRefresh.set(false);
    void this.read();
  }

  protected checkedTime(): string {
    const checkedAt = this.explanation()?.checkedAt;
    if (!checkedAt) return '';
    const date = new Date(checkedAt);
    const day = date.getUTCDate();
    const month = date.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' });
    const year = date.getUTCFullYear();
    const time = date.toLocaleTimeString('en-GB', {
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC',
    });
    return `${day} ${month} ${year}, ${time} UTC`;
  }

  protected checkedClock(): string {
    const time = this.checkedTime();
    return time.slice(time.indexOf(', ') + 2);
  }

  protected grantStatus(grant: Grant): string {
    if (grant === 'allowed') return 'Granted';
    if (grant === 'denied') return 'Missing';
    return "Couldn't check";
  }

  protected grantClass(grant: Grant): string {
    if (grant === 'allowed') return 'granted';
    if (grant === 'denied') return 'missing';
    return 'unknown';
  }

  protected requesterSource(): string {
    const reply = this.explanation();
    if (!reply || !('sources' in reply)) return '—';
    const sources = reply.sources.filter(isRequesterSource);
    return sources.map(sourceLabel).join(', ') || '—';
  }

  protected assistantSource(): string {
    const reply = this.explanation();
    if (!reply || !('sources' in reply)) return '—';
    const sources = reply.sources.filter(isAssistantSource);
    return sources.map(sourceLabel).join(', ') || '—';
  }

  protected accountStatus(): string {
    const reply = this.explanation();
    if (!reply || !('profile' in reply)) return 'Not checked';
    if (reply.profile === 'not_required') return 'No account needed';
    if (reply.profile === 'absent_on_version') return 'Not connected';
    return "Couldn't check";
  }

  protected accountSource(): string {
    const reply = this.explanation();
    if (!reply || !('profile' in reply)) return '—';
    if (reply.profile === 'absent_on_version') return 'Settings → My tools';
    return '—';
  }

  protected accountHint(): string {
    const reply = this.explanation();
    if (reply && 'profile' in reply && reply.profile === 'absent_on_version') {
      if (this.requesterName() === 'This person') return 'Only this person can connect it';
      return `Only ${this.requesterName()} can connect it`;
    }
    return '';
  }

  protected reasons(): string[] {
    const reply = this.explanation();
    if (!reply) return [];
    return reply.reasons.map(plainReason);
  }

  protected hasDetail(): boolean {
    const reply = this.explanation();
    return !!reply && 'sources' in reply;
  }

  private async read(): Promise<void> {
    const generation = ++this.generation;
    const request = new AbortController();
    this.requests.add(request);
    const parameters = new URLSearchParams({
      requesterId: this.requesterId, assistantId: this.assistantId, toolName: this.toolName(),
    });
    const url = `/api/org/integrations/${encodeURIComponent(this.serverId())}` +
      `/access/explanation?${parameters.toString()}`;
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/json' }, signal: request.signal,
      });
      // Process every refusal before dropping an older reply. An older read can revoke this page.
      if (response.status === 401 || response.status === 403) {
        this.loseAccess(response.status);
        return;
      }
      if (this.ignore(generation)) return;
      if (response.status === 400) {
        this.explanation.set(undefined);
        this.toolName.set('');
        this.state.set('incomplete');
        return;
      }
      if (!response.ok) throw new Error('Explanation read failed');
      const body: unknown = await response.json();
      if (this.ignore(generation)) return;
      const parsed = toolAccessExplanationSchema.parse(body);
      if (parsed.serverId !== this.serverId() || parsed.requesterId !== this.requesterId ||
          parsed.assistantId !== this.assistantId || parsed.toolName !== this.toolName()) {
        throw new Error('Explanation context changed');
      }
      this.explanation.set(parsed);
      this.failedRefresh.set(false);
      this.state.set('ready');
    } catch {
      if (this.ignore(generation)) return;
      if (this.explanation()) {
        this.failedRefresh.set(true);
      } else {
        this.state.set('failed');
      }
    } finally {
      this.requests.delete(request);
      if (!this.ignore(generation)) this.refreshing.set(false);
    }
  }

  private ignore(generation: number): boolean {
    return this.destroyed || this.accessLost || generation !== this.generation;
  }

  private loseAccess(status: number): void {
    if (this.accessLost || this.destroyed) return;
    this.accessLost = true;
    this.generation += 1;
    this.abortReads();
    this.explanation.set(undefined);
    this.toolName.set('');
    this.requesterName.set('');
    this.assistantName.set('');
    this.failedRefresh.set(false);
    this.refreshing.set(false);
    this.state.set(status === 401 ? 'sign-in' : 'refused');
    requestAnimationFrame(focusRefusal);
  }

  private abortReads(): void {
    for (const request of this.requests) request.abort();
    this.requests.clear();
  }
}

function isRequesterSource(source: Source): boolean {
  return source.kind === 'direct' || source.kind === 'group';
}

function isAssistantSource(source: Source): boolean {
  return source.kind === 'assistant';
}

function sourceLabel(source: Source): string {
  if (source.kind === 'group') return `Via ${source.groupName || 'a group'}`;
  return 'Direct grant';
}

function plainReason(reason: string): string {
  return reasonText[reason] ?? "Another check didn't pass";
}

function focusRefusal(): void {
  globalThis.document.getElementById('tool-access-refusal')?.focus();
}
