import { ChangeDetectionStrategy, Component, computed, effect, ElementRef, inject,
  input, output, signal, type OnDestroy, type OnInit } from '@angular/core';
import { z } from 'zod';
import { modelAccessResponseSchema, modelAccessGrantSchema, modelAccessCandidatesResponseSchema,
  modelAccessChangeSchema, modelAccessCommandSchema, memberAccessSchema } from '@opencrane/protocol';
import { SharedState, type PresentationState } from '../shared-state/shared-state';

const progress = z.enum(['current', 'applying']);
const nullableText = z.string().nullable();
const nullableNumber = z.number().nullable();
const accessProjectionSchema = z.object({ content: progress, iam: progress, sequence: z.number() });
const audienceGrantSchema = modelAccessGrantSchema.extend({
  iam: progress, membershipStatus: nullableText,
});
const audienceGrantsSchema = z.array(audienceGrantSchema);
const boundedGrantsSchema = audienceGrantsSchema.max(100);
const accessFieldsSchema = modelAccessResponseSchema.pick({
  expectedSequence: true, loadedAt: true, canManage: true,
});
const accessSchema = accessFieldsSchema.extend({
  serverId: z.string(), complete: z.boolean(), grantTotal: nullableNumber,
  projection: accessProjectionSchema, grants: boundedGrantsSchema,
});
const changeFieldsSchema = modelAccessChangeSchema.omit({ modelId: true });
const changeSchema = changeFieldsSchema.extend({ serverId: z.string() });
const referenceSchema = modelAccessCommandSchema.pick({ commandId: true, action: true });
type Candidate = z.infer<typeof modelAccessCandidatesResponseSchema>;
type Edit = { action: 'grant' | 'revoke'; granteeKind: 'member' | 'assistant';
  granteeId: string; displayName: string };

@Component({
  selector: 'oc-tool-audience', imports: [SharedState], templateUrl: './tool-audience.html',
  styleUrl: '../models/model-access-editor.css',
  styles: ['button { max-width: 100%; overflow-wrap: anywhere; }',
    'a { display: inline-flex; align-items: center; min-height: 44px; }',
    'select { min-height: 44px; max-width: 100%; }'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ToolAudience implements OnInit, OnDestroy {
  readonly serverId = input.required<string>();
  readonly toolName = input('');
  readonly disabled = input(false);
  readonly ready = output<boolean>();
  readonly pendingChange = output<boolean>();
  readonly accessEnded = output<Response>();
  protected readonly list = signal<z.infer<typeof accessSchema> | undefined>(undefined);
  protected readonly candidates = signal<Candidate | undefined>(undefined);
  protected readonly edit = signal<Edit | undefined>(undefined);
  protected readonly pending = signal<z.infer<typeof referenceSchema> | undefined>(undefined);
  protected readonly labels = { member: 'Person', assistant: 'Assistant', team: 'Group' };
  protected readonly kind = signal<'member' | 'assistant'>('member');
  protected readonly busy = signal(false);
  protected readonly picking = signal(false);
  protected readonly state = signal<PresentationState>('checking');
  protected readonly message = signal('Loading access…');
  protected readonly locked = computed(this.isLocked.bind(this));
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly request = new AbortController();
  protected readonly explanationPerson = signal('');
  protected readonly explanationAssistant = signal('');
  protected readonly explanationAssistants = signal<{ id: string; displayName: string }[]>([]);
  protected readonly explanationMessage = signal('Choose a person and assistant to explain access.');
  private candidateRead = 0;
  private explanationRead = 0;

  constructor() {
    effect(this.reportReady.bind(this));
  }
  ngOnInit(): void {
    try {
      const raw = sessionStorage.getItem(this.storageKey());
      if (raw) this.pending.set(referenceSchema.parse(JSON.parse(raw)));
    } catch {
      // Keep unreadable recovery read-only until the page can be checked by an admin.
      this.state.set('unknown');
      this.message.set('The saved reference could not be read. Access cannot be changed here.');
      return;
    }
    if (this.pending()) void this.check();
    else void this.refresh();
  }
  ngOnDestroy(): void {
    this.request.abort();
  }
  private isLocked(): boolean {
    return this.busy() || this.disabled() || !!this.pending() || !!this.edit()
      || !this.list()?.canManage || this.state() !== 'ready' && this.state() !== 'confirmed';
  }
  private reportReady(): void {
    this.ready.emit(!this.locked() && !this.picking());
    this.pendingChange.emit(this.pending() !== undefined);
  }
  protected async refresh(): Promise<void> {
    if (this.busy() || this.pending()) return;
    this.busy.set(true);
    await this.readAccess();
    this.busy.set(false);
  }
  private async readAccess(sequence = 0): Promise<boolean> {
    const reply = await this.call('');
    if (!reply) return false;
    const parsed = accessSchema.safeParse(reply.data);
    if (reply.code !== 200 || !parsed.success || parsed.data.serverId !== this.serverId()) {
      this.show('failed', 'Access could not be checked. This is not a denial.');
      return false;
    }
    const list = parsed.data;
    this.clearExplanation();
    this.list.set(list);
    if (!list.complete || list.expectedSequence < sequence
      || list.projection.content !== 'current' || list.projection.iam !== 'current') {
      this.show('applying', 'Access is still updating or the list is incomplete.');
      return false;
    }
    this.show('ready', list.grants.length ? 'Saved audience' : 'No audience yet');
    return true;
  }
  protected async add(kind: 'member' | 'assistant', after?: string): Promise<void> {
    if (this.locked()) return;
    if (!after) this.candidates.set(undefined);
    this.kind.set(kind);
    this.picking.set(true);
    const read = ++this.candidateRead;
    const cursor = after ? `&after=${encodeURIComponent(after)}` : '';
    const reply = await this.call(`/candidates?kind=${kind}&limit=50${cursor}`);
    if (!reply || read !== this.candidateRead) return;
    this.picking.set(false);
    const parsed = modelAccessCandidatesResponseSchema.safeParse(reply.data);
    if (reply.code !== 200 || !parsed.success || parsed.data.projection.content !== 'current') {
      this.candidates.set(undefined);
      this.message.set('Candidates could not be checked. Choose Person or Assistant to check again.');
      return;
    }
    const rows = new Map<string, Candidate['rows'][number]>();
    if (after) {
      for (const row of this.candidates()?.rows ?? []) {
        rows.set(row.id, row);
      }
    }
    for (const row of parsed.data.rows) {
      rows.set(row.id, row);
    }
    this.candidates.set({ ...parsed.data, rows: [...rows.values()] });
  }
  protected alreadyGranted(id: string): boolean {
    for (const row of this.list()?.grants ?? []) {
      if (row.granteeKind === this.kind() && row.granteeId === id && row.state === 'granted') {
        return true;
      }
    }
    return false;
  }
  protected choose(granteeKind: 'member' | 'assistant', granteeId: string,
    displayName: string, action: Edit['action']): void {
    if (this.locked() || action === 'grant' && this.alreadyGranted(granteeId)) return;
    this.edit.set({ granteeKind, granteeId, displayName, action });
    this.candidateRead += 1;
    this.candidates.set(undefined);
    this.picking.set(false);
    this.focus();
  }
  protected cancel(): void {
    this.edit.set(undefined);
    this.focus();
  }
  protected async save(): Promise<void> {
    const edit = this.edit();
    const list = this.list();
    if (!edit || !list || this.busy() || this.pending() || this.disabled()) return;
    const command = { commandId: crypto.randomUUID(), expectedSequence: list.expectedSequence,
      action: edit.action, granteeKind: edit.granteeKind, granteeId: edit.granteeId };
    this.pending.set({ commandId: command.commandId, action: command.action });
    this.store();
    this.pendingChange.emit(true);
    this.edit.set(undefined);
    this.busy.set(true);
    this.show('applying', 'Applying');
    this.focus();
    const reply = await this.call('/changes', command);
    if (!reply) return;
    this.busy.set(false);
    const failure = z.object({ status: z.string() }).safeParse(reply.data);
    if (reply.code === 409 || reply.code === 200 && failure.data?.status === 'no_effect') {
      this.pending.set(undefined);
      this.store();
      this.show('needs_input', reply.code === 409
        ? 'Access changed. Refresh before choosing again.' : 'Nothing changed. Refresh the audience.');
      return;
    }
    // Read the original receipt even when HTTP accepted the change or lost its reply.
    await this.check();
  }
  protected async check(): Promise<void> {
    const pending = this.pending();
    if (!pending || this.busy()) return;
    this.busy.set(true);
    const reply = await this.call(`/changes/${encodeURIComponent(pending.commandId)}`);
    if (!reply) return;
    const parsed = changeSchema.safeParse(reply.data);
    const operation = pending.action === 'grant' ? 'grant.given' : 'grant.revoked';
    this.show('unknown', 'Outcome unknown. Check the original reference.');
    if (reply.code === 200 && parsed.success && parsed.data.serverId === this.serverId()
      && parsed.data.commandId === pending.commandId && parsed.data.operation === operation) {
      this.show('applying', 'Applying');
      if (parsed.data.projection.content === 'current' && parsed.data.projection.iam === 'current'
        && await this.readAccess(parsed.data.sequence)) {
        this.pending.set(undefined);
        this.store();
        this.show('confirmed', 'Saved. Nobody can use these tools before publication.');
      }
    }
    this.busy.set(false);
    this.focus();
  }
  protected explanationPeople() {
    const people = [];
    for (const row of this.list()?.grants ?? []) {
      if (row.state === 'granted' && row.granteeKind === 'member') {
        people.push(row);
      }
    }
    return people;
  }
  private offersExplanationPerson(personId: string): boolean {
    for (const person of this.explanationPeople()) {
      if (person.granteeId === personId) {
        return true;
      }
    }
    return false;
  }
  protected async selectExplanationPerson(personId: string): Promise<void> {
    if (this.locked()) {
      return;
    }
    this.clearExplanation();
    if (!this.offersExplanationPerson(personId)) {
      return;
    }
    this.explanationPerson.set(personId);
    this.explanationMessage.set('Checking this person’s assistants…');
    const read = ++this.explanationRead;
    this.busy.set(true);
    const path = `/api/members/${encodeURIComponent(personId)}/access`;
    const reply = await this.fetchReply(path);
    this.busy.set(false);
    if (!reply || read !== this.explanationRead) {
      return;
    }
    const parsed = memberAccessSchema.safeParse(reply.data);
    this.explanationMessage.set('This person’s assistants could not be checked. Choose again.');
    if (reply.code !== 200 || !parsed.success) {
      return;
    }
    // Accept dated assistant context only when its membership and grant reads succeeded.
    const unrelatedSections = new Set(['use_availability', 'tool_policy', 'tool_limits']);
    for (const section of parsed.data.unavailableSections) {
      if (!unrelatedSections.has(section)) {
        return;
      }
    }
    const assistants = [];
    for (const row of parsed.data.rows) {
      if (row.resourceType !== 'mcp_server' || row.resourceId !== this.serverId()) {
        continue;
      }
      for (const assistant of row.eligibility.assistants) {
        const displayName = this.assistantName(assistant.assistantId);
        assistants.push({ id: assistant.assistantId, displayName });
      }
    }
    this.explanationAssistants.set(assistants);
    this.explanationMessage.set(assistants.length
      ? 'Choose an assistant to explain access.' : 'No assistants are available for this person.');
  }
  protected selectExplanationAssistant(assistantId: string): void {
    if (this.locked()) {
      return;
    }
    this.explanationAssistant.set('');
    for (const assistant of this.explanationAssistants()) {
      if (assistant.id === assistantId) {
        this.explanationAssistant.set(assistantId);
        return;
      }
    }
  }
  private assistantName(assistantId: string): string {
    for (const row of this.list()?.grants ?? []) {
      if (row.granteeKind === 'assistant' && row.granteeId === assistantId) {
        return row.displayName;
      }
    }
    return assistantId;
  }
  private clearExplanation(): void {
    this.explanationRead += 1;
    this.explanationPerson.set('');
    this.explanationAssistant.set('');
    this.explanationAssistants.set([]);
    this.explanationMessage.set('Choose a person and assistant to explain access.');
  }
  protected explanation(): string | undefined {
    const person = this.explanationPerson();
    const assistant = this.explanationAssistant();
    if (this.locked() || !person || !assistant || !this.toolName()) {
      return undefined;
    }
    const query = new URLSearchParams({ requester: person, assistant, tool: this.toolName() });
    return `/org/integrations/${encodeURIComponent(this.serverId())}/access/explanation?${query}`;
  }
  private show(state: PresentationState, message: string): void {
    this.state.set(state);
    this.message.set(message);
  }
  private focus(): void {
    const region = this.element.nativeElement.querySelector<HTMLElement>('[role="status"]');
    region?.focus();
  }
  private storageKey(): string {
    return `tool-audience:${this.serverId()}`;
  }
  private store(): void {
    try {
      const pending = this.pending();
      if (pending) sessionStorage.setItem(this.storageKey(), JSON.stringify(pending));
      else sessionStorage.removeItem(this.storageKey());
    } catch {
      // Keep the original reference in memory if browser storage is blocked.
    }
  }
  private async call(suffix: string, command?: unknown) {
    const path = `/api/org/integrations/${encodeURIComponent(this.serverId())}/access${suffix}`;
    return this.fetchReply(path, command);
  }
  private async fetchReply(path: string, command?: unknown) {
    const signal = AbortSignal.any([this.request.signal, AbortSignal.timeout(10_000)]);
    const options: RequestInit = { signal, cache: 'no-store' };
    if (command) {
      options.method = 'POST';
      options.headers = { 'content-type': 'application/json' };
      options.body = JSON.stringify(command);
    }
    try {
      const response = await fetch(path, options);
      if (response.status === 401 || response.status === 403) {
        this.request.abort();
        this.clearExplanation();
        this.list.set(undefined);
        this.candidates.set(undefined);
        this.edit.set(undefined);
        this.pending.set(undefined);
        this.store();
        this.show('access_changed', 'Access changed. Details cleared.');
        this.accessEnded.emit(response);
      }
      if (this.request.signal.aborted) return undefined;
      const data: unknown = await response.json();
      if (!this.request.signal.aborted) return { code: response.status, data };
    } catch {
      if (!this.request.signal.aborted) return { code: 0, data: undefined };
    }
    return undefined;
  }
}
