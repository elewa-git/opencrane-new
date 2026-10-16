import { ChangeDetectionStrategy, Component, effect, input, output, signal,
  type OnDestroy } from '@angular/core';
import { z } from 'zod';
import { modelAccessResponseSchema, type ModelAccessResponse } from '@opencrane/protocol';
import type { ProviderRow, TaskRouting } from './provider-api';

const bindingSchema = z.object({ kind: z.enum(['assistant', 'silo_default']),
  dependantId: z.string(), task: z.string(), state: z.enum(['active', 'paused']),
  model: z.string(), assistantCount: z.number().int().nonnegative() }).passthrough();
const bindingsSchema = z.object({ rows: z.array(bindingSchema) });
const assistantsSchema = z.object({ rows: z.array(z.object({ assistantId: z.string(),
  name: z.string().optional() }).passthrough()) });

type Binding = z.infer<typeof bindingSchema>;
type Assistant = z.infer<typeof assistantsSchema>['rows'][number];
type Details = { access: Map<string, ModelAccessResponse>; bindings?: Binding[] | undefined;
  assistants?: Assistant[] | undefined };
type Denial = 'access' | 'forbidden';

@Component({
  selector: 'oc-model-table', templateUrl: './model-table.html', styleUrl: './model-table.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ModelTable implements OnDestroy {
  readonly providers = input.required<ProviderRow[]>();
  readonly registry = input.required<string[]>();
  readonly routing = input.required<TaskRouting>();
  readonly editorOpened = input(false);
  readonly access = output<{ model: string; opener: HTMLElement }>();
  readonly lostAccess = output<Denial>();
  protected readonly details = signal<Details>({ access: new Map() });
  private request = new AbortController();
  private generation = 0;
  private lastOpenedModel = '';
  private wasEditorOpened = false;

  constructor() {
    effect(this.refreshForSnapshot.bind(this));
    effect(this.refreshAfterEditor.bind(this));
  }

  private refreshForSnapshot(): void {
    const providers = this.providers();
    const registry = this.registry();
    void this.load(providers, registry);
  }

  private refreshAfterEditor(): void {
    const opened = this.editorOpened();
    if (this.wasEditorOpened && !opened && this.lastOpenedModel) {
      void this.refreshModel(this.lastOpenedModel);
    }
    this.wasEditorOpened = opened;
  }

  ngOnDestroy(): void {
    this.request.abort();
    this.generation++;
  }

  protected enabledModels(): string[] {
    const enabled = new Set<string>();
    for (const provider of this.providers()) {
      if (provider.provider !== 'openai') continue;
      for (const model of provider.enabledModels) enabled.add(model);
    }
    const models: string[] = [];
    for (const model of this.registry()) {
      if (enabled.has(model)) models.push(model);
    }
    return models;
  }

  protected connectionNames(model: string): string {
    const names: string[] = [];
    for (const provider of this.providers()) {
      if (provider.provider === 'openai' && provider.enabledModels.includes(model)) {
        names.push(`OpenAI · ${provider.name}`);
      }
    }
    return names.join(', ');
  }

  protected taskWords(model: string): string {
    const tasks: string[] = [];
    for (const [task, route] of Object.entries(this.routing())) {
      if (route.model === model) tasks.push(task.replaceAll('_', ' '));
    }
    return tasks.join(', ') || 'No task route';
  }

  protected grantedRows(model: string): ModelAccessResponse['grants'] {
    const access = this.details().access.get(model);
    if (!access) return [];
    return access.grants.filter(isGranted);
  }

  protected audienceSummary(model: string): string {
    const access = this.details().access.get(model);
    if (!access) return 'Access not checked';
    if (access.projection.content !== 'current') return 'Still updating';
    if (access.grants.length !== access.grantTotal) {
      return `Showing ${access.grants.length} of ${access.grantTotal}`;
    }
    return this.grantedRows(model).length ? '' : 'No audience';
  }

  protected warning(model: string): string | undefined | null {
    const details = this.details();
    const access = details.access.get(model);
    if (!access || !details.bindings || !details.assistants
      || access.projection.content !== 'current'
      || access.grants.length !== access.grantTotal
      || !allRelevantAssistantsChecked(model, details.bindings, details.assistants)) {
      return undefined;
    }
    return missingAssistantNames(model, access.grants, details.bindings, details.assistants);
  }

  protected openAccess(model: string, opener: HTMLElement): void {
    this.lastOpenedModel = model;
    this.access.emit({ model, opener });
  }

  private async load(providers: ProviderRow[], registry: string[]): Promise<void> {
    this.request.abort();
    this.request = new AbortController();
    const generation = ++this.generation;
    const signal = this.request.signal;
    const { models, bindingProviders } = enabledSources(providers, registry);
    const accessReads: Promise<ModelAccessResponse | undefined>[] = [];
    for (const model of models) {
      accessReads.push(this.readAccess(model, signal, generation));
    }
    const bindingReads: Promise<Binding[] | undefined>[] = [];
    for (const provider of bindingProviders) {
      bindingReads.push(this.readBindings(provider, signal, generation));
    }
    const assistantRead = models.length ? this.readAssistants(signal, generation)
      : Promise.resolve(undefined);
    const [accessReplies, bindingReplies, assistants] = await Promise.all([
      Promise.all(accessReads), Promise.all(bindingReads), assistantRead,
    ]);
    if (signal.aborted || generation !== this.generation) return;
    const access = new Map<string, ModelAccessResponse>();
    for (const reply of accessReplies) {
      if (reply) access.set(reply.modelId, reply);
    }
    const bindings = completeBindings(bindingReplies);
    this.details.set({ access, bindings, assistants });
  }

  private async refreshModel(model: string): Promise<void> {
    const generation = this.generation;
    const access = await this.readAccess(model, this.request.signal, generation);
    if (!access || this.request.signal.aborted || generation !== this.generation) return;
    const previous = this.details();
    const updated = new Map(previous.access);
    updated.set(model, access);
    this.details.set({ ...previous, access: updated });
  }

  private async readAccess(model: string, signal: AbortSignal,
    generation: number): Promise<ModelAccessResponse | undefined> {
    const url = `/api/org/models/${encodeURIComponent(model)}/access`;
    const reply = await this.read(url, modelAccessResponseSchema, signal, generation);
    return reply?.modelId === model ? reply : undefined;
  }

  private async readBindings(provider: ProviderRow, signal: AbortSignal,
    generation: number): Promise<Binding[] | undefined> {
    const url = `/api/org/providers/${encodeURIComponent(provider.providerId)}/bindings`;
    const reply = await this.read(url, bindingsSchema, signal, generation);
    return reply?.rows;
  }

  private async readAssistants(signal: AbortSignal,
    generation: number): Promise<Assistant[] | undefined> {
    const reply = await this.read('/api/assistants', assistantsSchema, signal, generation);
    return reply?.rows;
  }

  private async read<T>(url: string, schema: z.ZodType<T>, signal: AbortSignal,
    generation: number): Promise<T | undefined> {
    try {
      const response = await fetch(url, { headers: { accept: 'application/json' }, signal });
      if (signal.aborted || generation !== this.generation) return undefined;
      if (response.status === 401 || response.status === 403) {
        this.request.abort();
        this.generation++;
        this.details.set({ access: new Map() });
        this.lostAccess.emit(response.status === 401 ? 'access' : 'forbidden');
        return undefined;
      }
      if (!response.ok) return undefined;
      const body: unknown = await response.json();
      if (signal.aborted || generation !== this.generation) return undefined;
      const parsed = schema.safeParse(body);
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }
}

function missingAssistantNames(model: string, grants: ModelAccessResponse['grants'],
  bindings: Binding[], assistants: Assistant[]): string | undefined | null {
  const granted = new Set<string>();
  for (const row of grants) {
    if (row.granteeKind === 'assistant' && row.state === 'granted') {
      granted.add(row.granteeId);
    }
  }
  const defaults = bindings.filter(isActiveDefaultFor(model));
  const ownBindings = bindings.filter(isOwnBinding);
  const missingNames: string[] = [];
  for (const assistant of assistants) {
    const own = ownBindings.find(isForAssistant(assistant.assistantId));
    const usesModel = own ? own.state === 'active' && own.model === model
      : defaults.length > 0;
    if (!usesModel || granted.has(assistant.assistantId)) continue;
    if (!assistant.name) return undefined;
    missingNames.push(assistant.name);
  }
  return missingNames.length ? missingNames.join(', ') : null;
}

function enabledSources(providers: ProviderRow[], registry: string[]) {
  const enabled = new Set<string>();
  const bindingProviders: ProviderRow[] = [];
  for (const provider of providers) {
    if (provider.provider !== 'openai') continue;
    let enablesRegistryModel = false;
    for (const model of provider.enabledModels) {
      if (registry.includes(model)) enablesRegistryModel = true;
    }
    if (!enablesRegistryModel) continue;
    bindingProviders.push(provider);
    for (const model of provider.enabledModels) enabled.add(model);
  }
  const models: string[] = [];
  for (const model of registry) {
    if (enabled.has(model)) models.push(model);
  }
  return { models, bindingProviders };
}

function completeBindings(replies: (Binding[] | undefined)[]): Binding[] | undefined {
  const bindings: Binding[] = [];
  for (const reply of replies) {
    if (!reply) return undefined;
    bindings.push(...reply);
  }
  return bindings;
}

function isGranted(row: ModelAccessResponse['grants'][number]): boolean {
  return row.state === 'granted';
}

function isActiveDefaultFor(model: string): (binding: Binding) => boolean {
  function matches(binding: Binding): boolean {
    return binding.kind === 'silo_default' && binding.state === 'active'
      && binding.model === model;
  }
  return matches;
}

function isOwnBinding(binding: Binding): boolean {
  return binding.kind === 'assistant';
}

function isForAssistant(assistantId: string): (binding: Binding) => boolean {
  function matches(binding: Binding): boolean {
    return binding.dependantId === assistantId;
  }
  return matches;
}

function hasOwnBinding(assistantId: string, task: string, bindings: Binding[]): boolean {
  for (const binding of bindings) {
    if (binding.kind === 'assistant' && binding.dependantId === assistantId
      && binding.task === task) return true;
  }
  return false;
}

function allRelevantAssistantsChecked(model: string, bindings: Binding[],
  assistants: Assistant[]): boolean {
  for (const binding of bindings) {
    if (binding.state !== 'active' || binding.model !== model) continue;
    let checkedCount = 0;
    for (const assistant of assistants) {
      if (binding.kind === 'assistant') {
        if (assistant.assistantId === binding.dependantId) checkedCount++;
      } else if (!hasOwnBinding(assistant.assistantId, binding.task, bindings)) {
        checkedCount++;
      }
    }
    // The server counts personal assistants too, but the names read only lists shared ones.
    if (checkedCount !== binding.assistantCount) return false;
  }
  return true;
}
