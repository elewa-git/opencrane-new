import { ChangeDetectionStrategy, Component } from '@angular/core';
import { SharedState } from '../shared-state/shared-state';

@Component({
  selector: 'oc-integrations-access-lost',
  imports: [SharedState],
  templateUrl: './integrations-access-lost.html',
  styleUrl: './integrations-access-lost.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class IntegrationsAccessLost {}
