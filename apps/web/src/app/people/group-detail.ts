import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { GroupRow } from '@opencrane/protocol';
import { SharedState } from '../shared-state/shared-state';
import { DogEar } from '../ui/paper';
import { compareByDisplayName, grantCountLabel, grantSentence, memberCountLabel, sharedAssistantIds,
  sourceLabel, useGrants } from './group-wording';

@Component({ selector: 'oc-group-detail', imports: [SharedState, DogEar],
  templateUrl: './group-detail.html', styleUrls: ['./people.css'],
  changeDetection: ChangeDetectionStrategy.OnPush })
export class GroupDetail {
  readonly group = input.required<GroupRow>();
  readonly canManage = input(false);
  protected readonly compareByDisplayName = compareByDisplayName;
  protected readonly grantSentence = grantSentence;
  protected readonly grantCountLabel = grantCountLabel;
  protected readonly memberCountLabel = memberCountLabel;
  protected readonly sharedAssistantIds = sharedAssistantIds;
  protected readonly sourceLabel = sourceLabel;
  protected readonly useGrants = useGrants;
  protected sortedMembers(): GroupRow['members'] {
    return [...this.group().members].sort(compareByDisplayName);
  }
}
