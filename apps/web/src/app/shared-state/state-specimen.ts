import { ChangeDetectionStrategy, Component } from '@angular/core';
import { SharedState, type PresentationState } from './shared-state';
import { Crease, DogEar } from '../ui/paper';
import { FlutterLoader } from '../ui/flutter-loader';
import { GrainLoader } from '../ui/grain-loader';
import { FoldLoader } from '../ui/fold-loader/fold-loader';

interface StateExample {
  kind: PresentationState;
  message: string;
  need: string;
  interaction: string;
  safe?: boolean;
  evidenceAt?: string;
  timestamp?: string;
  changeReference?: string;
}

const EXAMPLES: readonly StateExample[] = [
  {
    kind: 'not_configured', message: 'No connection set up',
    need: 'What is missing and who can configure it', interaction: 'Start setup',
  },
  {
    kind: 'draft', message: 'Steps 1–2 of 4 saved',
    need: 'Saved draft or unsent input; name what is missing', interaction: 'Continue',
  },
  {
    kind: 'checking', message: 'Reading the tool list…', changeReference: 'chg_7F3K',
    need: 'Which step is underway; keep the original reference',
    interaction: 'Wait — no duplicate submit',
  },
  {
    kind: 'ready', message: 'Tool list checked for this connection',
    evidenceAt: '2026-10-04T08:40:00Z', need: 'Dated evidence for this particular fact',
    interaction: 'Manage',
  },
  {
    kind: 'failed', message: 'Validation stopped before the change', safe: true,
    need: 'Server evidence that nothing changed', interaction: 'Try again',
  },
  {
    kind: 'unknown', message: 'We could not confirm the change', changeReference: 'chg_7F3K',
    need: 'Read evidence for the original operation', interaction: 'Check status — never resubmit',
  },
  {
    kind: 'access_changed', message: 'The Owner or Admin role is needed',
    need: 'Clear protected data and ignore late replies', interaction: 'Ask an admin',
  },
  {
    kind: 'paused', message: 'Tool definitions changed',
    need: 'Explain the cause and authorised resume path', interaction: 'Review changes',
  },
  {
    kind: 'blocked', message: 'Unreviewed tools cannot be called',
    need: 'A safe reason and remedy', interaction: 'Review tools',
  },
  {
    kind: 'removed', message: 'Connection removed; history kept',
    need: 'Retained history is explicit', interaction: 'New reviewed setup',
  },
  {
    kind: 'waiting', message: 'Waiting for the scheduled check', timestamp: '2026-10-04T10:00:00Z',
    need: 'An actual timestamp with timezone', interaction: 'Read status',
  },
];

@Component({
  selector: 'oc-state-specimen',
  imports: [SharedState, Crease, DogEar, FlutterLoader, GrainLoader, FoldLoader],
  templateUrl: './state-specimen.html',
  styleUrl: './state-specimen.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StateSpecimen {
  protected readonly examples = EXAMPLES;
}
