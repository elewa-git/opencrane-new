// The shell page: the product name, sign-in/sign-out and a connection
// indicator for the WebSocket link. No routing yet — there is only one
// page, so a plain component is all this needs.
import { ChangeDetectionStrategy, Component, type OnInit, computed, inject, signal } from '@angular/core';
import { logoutResponseSchema } from '@opencrane/protocol';
import { NAVIGATE } from './core/navigate';
import { WebSocketService, type ConnectionState } from './core/websocket.service';

const STATUS_LABEL: Record<ConnectionState, string> = {
  idle: 'Not connected',
  connecting: 'Connecting…',
  open: 'Connected',
  reconnecting: 'Reconnecting…',
  closed: 'Disconnected',
};

@Component({
  selector: 'app-root',
  imports: [],
  templateUrl: './app.html',
  styleUrl: './app.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App implements OnInit {
  private readonly ws = inject(WebSocketService);
  private readonly navigate = inject(NAVIGATE);

  protected readonly title = signal('OpenCrane');
  protected readonly connectionState = this.ws.state;
  protected readonly statusLabel = computed(() => STATUS_LABEL[this.connectionState()]);

  protected readonly signOutPending = signal(false);
  protected readonly signOutError = signal<string | undefined>(undefined);

  ngOnInit(): void {
    this.ws.connect();
  }

  protected signIn(): void {
    this.navigate('/auth/login');
  }

  protected async signOut(): Promise<void> {
    this.signOutPending.set(true);
    this.signOutError.set(undefined);
    try {
      const response = await fetch('/auth/logout', { method: 'POST' });
      if (!response.ok) {
        throw new Error(`sign out failed with status ${response.status}`);
      }
      this.navigate(await this.afterSignOutUrl(response));
    } catch (error) {
      this.signOutError.set(error instanceof Error ? error.message : 'sign out failed');
    } finally {
      this.signOutPending.set(false);
    }
  }

  // The server answers with the identity provider's logout page. Visit it so
  // the provider's session ends too (otherwise Sign in logs straight back
  // in). With no usable address, or an unreadable reply, go home.
  private async afterSignOutUrl(response: Response): Promise<string> {
    const body: unknown = await response.json().catch(() => null);
    const reply = logoutResponseSchema.safeParse(body);
    return reply.success && reply.data.endSessionUrl !== null ? reply.data.endSessionUrl : '/';
  }
}
