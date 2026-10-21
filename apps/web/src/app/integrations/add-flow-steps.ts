import { ChangeDetectionStrategy, Component, input } from '@angular/core';

type AddFlowStep = {
  number: number;
  label: string;
  unavailable: boolean;
};

const ADD_FLOW_STEPS: AddFlowStep[] = [
  { number: 1, label: 'Source', unavailable: false },
  { number: 2, label: 'Admission', unavailable: false },
  { number: 3, label: 'Connection', unavailable: true },
  { number: 4, label: 'Tools & access', unavailable: false },
  { number: 5, label: 'Publish', unavailable: false },
];

@Component({
  selector: 'oc-add-flow-steps',
  templateUrl: './add-flow-steps.html',
  styleUrl: './add-flow-steps.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AddFlowSteps {
  readonly current = input.required<1 | 2 | 3 | 4 | 5>();
  protected readonly steps = ADD_FLOW_STEPS;

  protected currentLabel(): string {
    for (const step of ADD_FLOW_STEPS) {
      if (step.number === this.current()) return step.label;
    }
    return '';
  }
}
