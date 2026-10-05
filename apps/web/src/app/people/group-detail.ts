import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import type { GroupRow } from '@opencrane/protocol';
import { SharedState } from '../shared-state/shared-state';
import { DogEar } from '../ui/paper';
import { compareByDisplayName, grantCountLabel, grantResourceLabel, memberCountLabel,
  sharedAssistantIds, sourceLabel, useGrants } from './group-wording';

export type RemoveRequested = {
  member: GroupRow['members'][number];
  opener: HTMLButtonElement;
};

@Component({ selector: 'oc-group-detail', imports: [SharedState, DogEar],
  templateUrl: './group-detail.html', styleUrls: ['./people.css'],
  changeDetection: ChangeDetectionStrategy.OnPush })
export class GroupDetail {
  readonly group = input.required<GroupRow>();
  readonly canManage = input(false);
  protected readonly grantResourceLabel = grantResourceLabel;
  readonly pendingMemberId = input<string | undefined>(undefined);
  readonly membersUnavailable = input(false);
  readonly removeRequested = output<RemoveRequested>();
  readonly refreshRequested = output<void>();
  protected readonly compareByDisplayName = compareByDisplayName;
  protected readonly grantCountLabel = grantCountLabel;
  protected readonly memberCountLabel = memberCountLabel;
  protected readonly sharedAssistantIds = sharedAssistantIds;
  protected readonly sourceLabel = sourceLabel;
  protected readonly useGrants = useGrants;
  protected requestRemove(member: GroupRow['members'][number], event: MouseEvent): void {
    const target = event.currentTarget;
    if (!(target instanceof HTMLButtonElement)) return;
    this.removeRequested.emit({ member, opener: target });
  }
  protected sortedMembers(): GroupRow['members'] {
    return [...this.group().members].sort(compareByDisplayName);
  }
}
