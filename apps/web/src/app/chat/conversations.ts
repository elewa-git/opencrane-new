import { ChangeDetectionStrategy, Component, ElementRef, signal, viewChild,
  type OnDestroy, type OnInit } from '@angular/core';
import type { ChatConversation } from '@opencrane/protocol';
import { NavigationMenu } from '../ui/navigation-menu';
import { ChatIcon } from './icon';
import { ConversationList, type ConversationSection } from './conversations-data';

@Component({
  selector: 'oc-conversations',
  imports: [NavigationMenu, ChatIcon],
  templateUrl: './conversations.html',
  styleUrl: './conversations.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Conversations implements OnInit, OnDestroy {
  protected readonly list = new ConversationList();
  protected readonly navigationOpen = signal(false);
  protected readonly menuOpener = viewChild<ElementRef<HTMLButtonElement>>('navigationOpener');

  ngOnInit(): void {
    const section = new URL(location.href).searchParams.get('section');
    void this.list.change(section === 'archived' ? 'archived' : 'recent', '');
  }

  ngOnDestroy(): void {
    this.list.destroy();
  }

  protected choose(section: ConversationSection): void {
    if (section === this.list.section()) return;
    const path = section === 'archived' ? '/workspace/conversations?section=archived'
      : '/workspace/conversations';
    history.replaceState({}, '', path);
    void this.list.change(section, this.list.query());
    this.navigationOpen.set(false);
  }

  protected searchChanged(event: Event): void {
    const field = event.target;
    if (!(field instanceof HTMLInputElement)) return;
    void this.list.change(this.list.section(), field.value);
  }

  protected clearSearch(): void {
    const field = document.querySelector<HTMLInputElement>('#conversation-search');
    if (field) field.value = '';
    void this.list.change(this.list.section(), '');
    field?.focus();
  }

  protected href(row: ChatConversation): string {
    const base = row.mode === 'agent_session' ? '/workspace' : '/workspace/direct';
    return `${base}?conversation=${encodeURIComponent(row.conversationId)}`;
  }

  protected mode(row: ChatConversation): string {
    if (row.mode === 'group') return 'Group chat';
    if (row.mode === 'direct') return 'Direct chat';
    if (row.assistantKind === 'team') return 'Shared assistant';
    return 'Personal assistant';
  }

  protected glyph(row: ChatConversation): string {
    return row.mode === 'agent_session' ? 'agent' : 'hash';
  }
}
