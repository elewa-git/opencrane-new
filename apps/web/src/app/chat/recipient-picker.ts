import {
  ChangeDetectionStrategy, Component, ElementRef, afterEveryRender, input, output, signal,
  viewChild,
} from '@angular/core';
import { chatGroupSnapshotSchema, chatGroupsSchema } from '@opencrane/protocol';

export type Colleague = { memberId: string; displayName: string | null };
type OwnGroup = { groupId: string; name: string };
export type ReviewedSnapshot = {
  groupId: string; name: string; position: number; members: Colleague[];
};

@Component({
  selector: 'oc-recipient-picker',
  templateUrl: './recipient-picker.html',
  styleUrl: './recipient-picker.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RecipientPicker {
  readonly searchState = input<'idle' | 'loading' | 'ready' | 'failed'>('ready');
  readonly colleagues = input.required<Colleague[]>();
  readonly query = input.required<string>();
  readonly selected = input<Colleague | undefined>();
  readonly draft = input(false);
  readonly disabled = input(false);
  readonly people = signal<Colleague[]>([]);
  readonly groups = signal<OwnGroup[]>([]);
  readonly snapshot = signal<ReviewedSnapshot | undefined>(undefined);
  readonly selectionError = signal('');
  readonly queryEdited = output<string>();
  readonly recipientSelected = output<Colleague>();
  readonly recipientChanged = output<void>();
  readonly selectionChanged = output<{ people: Colleague[]; snapshot?: ReviewedSnapshot }>();
  private readonly searchField = viewChild<ElementRef<HTMLInputElement>>('searchField');
  private readonly groupSelector = viewChild<ElementRef<HTMLSelectElement>>('groupSelector');
  private focusSearch = false;
  private focusGroupChoice = false;

  constructor() {
    afterEveryRender(this.restoreFocus.bind(this));
    void this.loadGroups();
  }

  async loadGroups(): Promise<void> {
    try {
      const response = await fetch('/api/chat/groups?limit=50', {
        headers: { accept: 'application/json' },
      });
      if (!response.ok) throw new Error('Group list unavailable');
      const parsed = chatGroupsSchema.parse(await response.json());
      this.groups.set(parsed.rows);
    } catch {
      this.selectionError.set('Your groups could not be loaded. People can still be selected.');
    }
  }

  protected queryChanged(event: Event): void {
    const field = event.target;
    if (!(field instanceof HTMLInputElement)) return;
    this.queryEdited.emit(field.value);
  }

  protected select(colleague: Colleague): void {
    if (this.people().some(isSameMember.bind(null, colleague.memberId))) return;
    this.people.update(addPerson.bind(null, colleague));
    this.emitSelection();
  }

  protected remove(colleague: Colleague): void {
    this.people.update(removePerson.bind(null, colleague.memberId));
    this.emitSelection();
  }

  protected async selectGroup(group: OwnGroup): Promise<void> {
    this.selectionError.set('');
    try {
      const response = await fetch(`/api/chat/groups/${encodeURIComponent(group.groupId)}`, {
        headers: { accept: 'application/json' },
      });
      if (!this.isCurrentGroupSelection(group.groupId)) return;
      if (response.status === 409) {
        this.selectionError.set('This group has more than 97 people. Select colleagues instead.');
        return;
      }
      if (!response.ok) throw new Error('Group snapshot unavailable');
      const snapshot = chatGroupSnapshotSchema.parse(await response.json());
      if (!this.isCurrentGroupSelection(group.groupId)) return;
      if (snapshot.members.length > 97) {
        this.selectionError.set('This group has more than 97 people. Select a smaller group.');
        return;
      }
      this.snapshot.set(snapshot);
      this.people.set(snapshot.members);
      this.emitSelection();
    } catch {
      if (!this.isCurrentGroupSelection(group.groupId)) return;
      this.selectionError.set('The group changed or could not be reviewed. Choose it again.');
      this.snapshot.set(undefined);
    }
  }

  protected groupChanged(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement)) return;
    const group = this.groups().find(findGroup.bind(null, target.value));
    if (group) void this.selectGroup(group);
    else this.clearGroup();
  }

  protected clearGroup(): void {
    this.snapshot.set(undefined);
    this.people.set([]);
    this.focusGroupChoice = true;
    this.emitSelection();
  }

  protected chooseAssistant(): void {
    if (this.people().length) {
      this.selectionError.set(
        'People and an assistant cannot share a new conversation. Remove the people first.',
      );
      return;
    }
    globalThis.location.assign('/workspace/shared');
  }

  protected change(): void {
    this.people.set([]);
    this.snapshot.set(undefined);
    this.recipientChanged.emit();
    this.focusSearch = true;
  }

  protected displayName(colleague: Colleague): string {
    return colleague.displayName?.trim() || colleague.memberId;
  }

  protected visiblePeople(): Colleague[] {
    return this.people().slice(0, 3);
  }

  private emitSelection(): void {
    const snapshot = this.snapshot();
    if (snapshot) this.selectionChanged.emit({ people: this.people(), snapshot });
    else this.selectionChanged.emit({ people: this.people() });
  }

  private isCurrentGroupSelection(groupId: string): boolean {
    return this.groupSelector()?.nativeElement.value === groupId;
  }

  protected finishSelection(): void {
    const people = this.people();
    if (people.length === 1 && !this.snapshot()) this.recipientSelected.emit(people[0]!);
  }

  private restoreFocus(): void {
    if (this.focusGroupChoice) {
      this.focusGroupChoice = false;
      requestAnimationFrame(this.focusGroupSelector.bind(this));
      return;
    }
    if (!this.focusSearch) return;
    this.focusSearch = false;
    requestAnimationFrame(this.focusSearchField.bind(this));
  }

  private focusSearchField(): void {
    this.searchField()?.nativeElement.focus();
  }

  private focusGroupSelector(): void {
    this.groupSelector()?.nativeElement.focus();
  }
}

function isSameMember(memberId: string, colleague: Colleague): boolean {
  return colleague.memberId === memberId;
}

function addPerson(colleague: Colleague, people: Colleague[]): Colleague[] {
  return [...people, colleague];
}

function removePerson(memberId: string, people: Colleague[]): Colleague[] {
  return people.filter(keepDifferentMember.bind(null, memberId));
}

function keepDifferentMember(memberId: string, colleague: Colleague): boolean {
  return colleague.memberId !== memberId;
}

function findGroup(groupId: string, group: OwnGroup): boolean {
  return group.groupId === groupId;
}
