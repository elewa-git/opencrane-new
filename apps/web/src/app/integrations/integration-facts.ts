import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { SharedState } from '../shared-state/shared-state';
import { DogEar } from '../ui/paper';
import type { IntegrationFact } from './integration-facts-map';

@Component({
  selector: 'oc-integration-facts',
  imports: [SharedState, DogEar],
  templateUrl: './integration-facts.html',
  styleUrl: './integration-facts.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class IntegrationFacts {
  readonly facts = input.required<readonly IntegrationFact[]>();
}
