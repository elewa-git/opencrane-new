import { signal } from '@angular/core';
import { chatGroupSnapshotSchema } from '@opencrane/protocol';
import { ReadFailure, requestChat } from './chat-session-http';

export class PayingGroupName {
  readonly name = signal('');
  private request = 0;
  private lastGroupId = '';
  private lastDenied = false;
  private readonly accessLost: () => void;

  constructor(accessLost: () => void) {
    this.accessLost = accessLost;
  }

  update(groupId: string, denied: boolean): void {
    if (groupId === this.lastGroupId && denied === this.lastDenied) return;
    this.lastGroupId = groupId;
    this.lastDenied = denied;
    const request = ++this.request;
    this.name.set('');
    if (!groupId || denied) return;
    void this.read(groupId, request);
  }

  private async read(groupId: string, request: number): Promise<void> {
    try {
      const path = `/api/chat/groups/${encodeURIComponent(groupId)}`;
      const group = chatGroupSnapshotSchema.parse(await requestChat(path));
      // Ignore a late name from a previous session or access period.
      if (request !== this.request || group.groupId !== groupId) return;
      this.name.set(group.name.trim());
    } catch (error) {
      if (request !== this.request) return;
      if (error instanceof ReadFailure && [401, 403].includes(error.status)) {
        this.accessLost();
      }
    }
  }
}
