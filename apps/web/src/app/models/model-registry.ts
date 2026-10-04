import {
  ChangeDetectionStrategy, Component, signal, type OnInit, type OnDestroy,
} from '@angular/core';
import { z } from 'zod';
import { SharedState, type PresentationState } from '../shared-state/shared-state';

const modelSchema = z.object({ id: z.string(), retired: z.boolean().optional() });
const responseSchema = z.object({ models: z.array(modelSchema) });
type Model = z.infer<typeof modelSchema>;

function activeModel(model: Model): boolean {
  return !model.retired;
}

@Component({
  selector: 'oc-models',
  imports: [SharedState],
  templateUrl: './model-registry.html',
  styleUrl: './model-registry.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ModelsScreen implements OnInit, OnDestroy {
  protected readonly models = signal<Model[]>([]);
  protected readonly kind = signal<PresentationState>('checking');
  protected readonly message = signal('Loading models…');
  protected readonly loadedAt = signal<string | undefined>(undefined);
  private readonly request = new AbortController();

  ngOnInit(): void {
    void this.load();
  }

  ngOnDestroy(): void {
    this.request.abort();
  }

  protected async load(): Promise<void> {
    this.loadedAt.set(undefined);
    this.kind.set('checking');
    this.message.set('Loading models…');
    try {
      const response = await fetch('/api/org/models', { signal: this.request.signal });
      if (this.request.signal.aborted) {
        return;
      }
      if (response.status === 401 || response.status === 403) {
        this.models.set([]);
        this.kind.set('access_changed');
        this.message.set('Access changed. Ask an Owner or Admin.');
        return;
      }
      if (!response.ok) {
        throw new Error('Unavailable');
      }
      const raw: unknown = await response.json();
      if (this.request.signal.aborted) {
        return;
      }
      const result = responseSchema.parse(raw);
      const models = result.models.filter(activeModel);
      this.models.set(models);
      this.kind.set('ready');
      this.loadedAt.set(new Date().toISOString());
      this.message.set('Model tariffs and task routing are fixed for this installation.');
    } catch {
      if (this.request.signal.aborted) {
        return;
      }
      this.kind.set('failed');
      this.message.set('Could not load models.');
    }
  }
}
