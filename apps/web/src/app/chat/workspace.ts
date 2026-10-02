// Workspace grid and message structure adapted from OpenCrane 1 10abd0ef6 (AGPL-3.0-or-later).
// Presentation follows the owner's Workspace Live; all state comes from the P2 bridge.
import { ChangeDetectionStrategy, Component, ElementRef, afterEveryRender, computed, inject, signal, viewChild, type OnInit } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { ChatSession } from './chat-session';
import { ChatComposer } from './composer';
import { WebSocketService } from '../core/websocket.service';
import { FilePreview } from './file-preview';

@Component({ selector: 'oc-workspace', imports: [ChatComposer, FilePreview, NgTemplateOutlet], providers: [ChatSession, WebSocketService],
  templateUrl: './workspace.html', styleUrls: ['./workspace.css', './transcript.css'], changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown)': 'shortcut($event)' } })
export class Workspace implements OnInit {
  protected readonly chat = inject(ChatSession);
  protected readonly draft = signal('');
  protected readonly rail = signal(false);
  protected readonly panel = signal(globalThis.innerWidth >= 1100);
  protected readonly archived = signal(false);
  protected readonly preview = signal('');
  protected readonly search = signal('');
  protected readonly transcriptElement = viewChild<ElementRef<HTMLElement>>('transcript');
  protected readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('panelDialog');
  protected readonly searchDialog = viewChild<ElementRef<HTMLDialogElement>>('searchDialog');
  protected readonly files = computed(() => [...new Set(this.chat.turns().flatMap(turn => turn.files))]);
  protected readonly title = computed(() => this.chat.turns().find(turn => turn.author === 'you')?.text.slice(0, 45) ?? (this.chat.selected() ? 'Personal session' : 'New session'));
  protected readonly reason = computed(() => this.chat.rows().some(row => row.type === 'conversation.closed') ? 'This session is closed. Start a new session to continue.' : this.chat.denied() ? 'Sign in to send messages.' : this.chat.loading() ? 'Loading your workspace…' : !this.chat.assistantId() ? 'Your personal agent is being prepared. Refresh shortly.' : '');
  private lastTranscript = '';
  constructor() {
    afterEveryRender(() => {
      const content = this.chat.turns().map(turn => turn.text + turn.state).join('');
      if (content !== this.lastTranscript) {
        this.lastTranscript = content;
        const element = this.transcriptElement()?.nativeElement;
        if (element) element.scrollTop = element.scrollHeight;
      }
    });
  }
  ngOnInit(): void { void this.chat.load(); }
  protected async send(text: string): Promise<void> { if (await this.chat.send(text)) this.draft.set(''); }
  protected newSession(): void { this.chat.newSession(); this.rail.set(false); this.focusComposer(); }
  protected select(id: string): void { void this.chat.select(id); this.rail.set(false); this.searchDialog()?.nativeElement.close(); this.focusComposer(); }
  protected togglePanel(): void {
    if (globalThis.innerWidth < 1100) this.dialog()?.nativeElement.showModal();
    else this.panel.update(value => !value);
  }
  protected shortcut(event: KeyboardEvent): void {
    if ((event.metaKey || event.ctrlKey) && (event.key.toLowerCase() === 'n' || (event.shiftKey && event.key.toLowerCase() === 'a'))) { event.preventDefault(); this.newSession(); }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); this.searchDialog()?.nativeElement.showModal(); }
    if (event.key === 'Escape' && this.rail()) { this.rail.set(false); document.getElementById('navigation-toggle')?.focus(); }
  }
  protected focusComposer(): void { document.getElementById('message')?.focus(); }
  protected rowStatus(id: string, status = 'open'): string {
    if (id !== this.chat.selected()) return status;
    if (this.chat.active()) return 'working';
    if (this.chat.rows().some(row => row.type === 'conversation.closed')) return 'closed';
    return this.chat.turns().filter(turn => turn.author === 'agent').at(-1)?.state ?? status;
  }
  protected glyph(status: string): string { return ({ working: '△', done: '✓', stopped: '■', failed: '×', closed: '▣' } as Record<string, string>)[status] ?? '#'; }
  protected words(status: string): string { return ({ working: 'Agent working', done: 'Done', stopped: 'Stopped', failed: 'Failed', closed: 'Closed', open: 'Open' } as Record<string, string>)[status] ?? 'Open'; }
  protected time(value: string): string { return new Date(value).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); }
  protected searchChanged(event: Event): void { if (event.target instanceof HTMLInputElement) this.search.set(event.target.value); }
  protected name(path: string): string { return path.split('/').at(-1) ?? path; }
  protected type(path: string): string { return path.split('.').at(-1)?.toUpperCase().slice(0, 5) ?? 'FILE'; }
  protected textParts(text: string): { text: string; kind: 'text' | 'bold' | 'citation' | 'a2ui' }[] {
    return text.split(/(\*\*[^*]+\*\*|\[\d+\]|```a2ui[\s\S]*?(?:```|$))/g).filter(Boolean).map(part => ({
      text: part.startsWith('**') ? part.slice(2, -2) : part,
      kind: part.startsWith('```a2ui') ? 'a2ui' : part.startsWith('**') ? 'bold' : /^\[\d+\]$/.test(part) ? 'citation' : 'text',
    }));
  }
}
