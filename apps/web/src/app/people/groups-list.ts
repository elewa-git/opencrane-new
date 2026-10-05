import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { GroupRow } from '@opencrane/protocol';
import { SharedState } from '../shared-state/shared-state';
import { memberCountLabel, sharedAssistantIds, sourceLabel } from './group-wording';

@Component({ selector: 'oc-groups-list', imports: [SharedState], templateUrl: './groups-list.html',
  styleUrls: ['./people.css'], changeDetection: ChangeDetectionStrategy.OnPush })
export class GroupsList {
  readonly rows = input.required<GroupRow[]>();
  readonly highlightedGroupId = input<string>();
  protected readonly memberCountLabel = memberCountLabel;
  protected readonly sharedAssistantIds = sharedAssistantIds;
  protected readonly sourceLabel = sourceLabel;

  protected assistantLine(group: GroupRow): string {
    const assistants = sharedAssistantIds(group.access.grants);
    if (assistants.length === 0) return 'No shared assistant';
    return 'Shared assistant: ' + assistants.join(', ');
  }
}
