import { SharedState, type PresentationState } from '../shared-state/shared-state';
import { IntegrationsAccessLost } from '../integrations/integrations-access-lost';
import { AddFlowSteps } from '../integrations/add-flow-steps';
import { DogEar } from '../ui/paper';
import { HostedInstall } from './hosted-install';
import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  inject,
  signal,
  type OnInit,
} from '@angular/core';
import { z } from 'zod';

const REFUSED_ADDRESS_DETAIL = 'Use a public HTTPS hostname. IP addresses, including private '
  + 'addresses, are not accepted. Nothing was registered.';

const statusSchema = z.object({
  serverId: z.string(),
  changeRef: z.string(),
  state: z.enum(['checking', 'needs_input', 'failed']),
  reason: z.string().optional(),
  inventory: z.object({
    schemaDigest: z.string(),
    serverInfo: z.object({
      name: z.string(),
      version: z.string(),
    }).default({ name: 'Server', version: 'Version not provided' }),
    tools: z.array(z.object({
      name: z.string(),
      revision: z.string(),
      definition: z.string().default('Definition not stored; rediscovery required.'),
      readOnly: z.boolean().default(false),
      destructive: z.boolean().default(false),
    })).default([]),
  }).optional(),
});

type DiscoveryStatus = z.infer<typeof statusSchema>;

@Component({
  selector: 'oc-mcp-install',
  imports: [SharedState, DogEar, IntegrationsAccessLost, AddFlowSteps, HostedInstall],
  templateUrl: './mcp-install.html',
  styleUrl: './mcp-install.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class McpInstall implements OnInit {
  private readonly document = inject(DOCUMENT);
  protected readonly toolGroups = [true, false];
  protected readonly serverId = new URLSearchParams(globalThis.location.search).get('server');
  protected readonly locator = signal('');
  protected readonly source = signal<'remote' | 'hosted'>('remote');
  protected readonly phase = signal<
    'draft' | 'checking' | 'unknown' | 'needs_input' | 'failed' | 'access' | 'refused'
  >('draft');
  protected readonly busy = signal(false);
  protected readonly changeRef = signal('');
  protected readonly discoveredServerId = signal('');
  protected readonly inventory = signal<DiscoveryStatus['inventory']>(undefined);
  protected readonly message = signal('Enter the server address to discover its tools.');

  ngOnInit(): void {
    if (this.serverId) {
      this.phase.set('unknown');
      void this.check();
      return;
    }
    const savedAddress = sessionStorage.getItem('mcp-registration');
    if (!savedAddress) return;
    this.locator.set(savedAddress);
    this.phase.set('unknown');
    this.message.set('Outcome unknown. Check status to restore your change.');
  }

  protected editAddress(address: string): void {
    this.locator.set(address);
    if (this.phase() !== 'refused') return;
    this.phase.set('draft');
    this.message.set('Enter the server address to discover its tools.');
  }

  protected chooseSource(source: 'remote' | 'hosted'): void {
    if (this.phase() !== 'draft') return;
    this.source.set(source);
  }

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    if (this.busy() || this.phase() !== 'draft') return;
    if (!this.isValidAddress(this.locator())) {
      this.message.set('Enter an HTTPS address without credentials, a query or a fragment.');
      return;
    }

    sessionStorage.setItem('mcp-registration', this.locator());
    this.busy.set(true);
    this.phase.set('checking');
    this.message.set('Registering server…');
    this.focusStatus();

    try {
      const response = await fetch('/api/org/integrations', this.registrationRequest());
      if (this.clearOnAccessLoss(response)) return;
      if (response.status === 400) {
        this.phase.set('refused');
        this.message.set('This address was refused.');
        sessionStorage.removeItem('mcp-registration');
        return;
      }
      if (!response.ok) {
        this.setUnknown();
        return;
      }
      const registration = await this.readRegistrationReply(response);
      this.changeRef.set(registration.changeRef);
      this.message.set('Validating the server and discovering tools…');
    } catch {
      this.setUnknown();
    } finally {
      this.busy.set(false);
    }
  }

  protected async check(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.message.set('Checking server status…');
    try {
      const response = await fetch(this.discoveryUrl());
      if (this.clearOnAccessLoss(response)) return;
      if (response.status === 404 && !this.serverId) {
        this.phase.set('draft');
        this.message.set('No registration was found. You can submit this source.');
        sessionStorage.removeItem('mcp-registration');
        globalThis.setTimeout(this.focusAddress, 0);
        return;
      }
      if (!response.ok) {
        throw new Error('Discovery status is unavailable');
      }
      const rawReply: unknown = await response.json();
      const status = statusSchema.parse(rawReply);
      this.applyDiscoveryStatus(status);
    } catch {
      this.setUnknown();
    } finally {
      this.busy.set(false);
    }
  }

  protected presentationState(): PresentationState {
    if (this.busy()) return 'checking';
    if (this.phase() === 'unknown') return 'unknown';
    const phase = this.phase();
    if (phase === 'access') return 'access_changed';
    return phase;
  }

  protected refusalDetail(): string | undefined {
    if (this.busy()) return undefined;
    if (this.phase() === 'refused') return REFUSED_ADDRESS_DETAIL;
    return undefined;
  }

  protected toolsUrl(): string {
    return `/org/integrations/${encodeURIComponent(this.discoveredServerId())}/tools`;
  }

  protected another(): void {
    sessionStorage.removeItem('mcp-registration');
    this.locator.set('');
    this.phase.set('draft');
    this.inventory.set(undefined);
    this.changeRef.set('');
    this.discoveredServerId.set('');
    this.message.set('Enter the server address to discover its tools.');
    globalThis.setTimeout(this.focusAddress, 0);
  }

  private applyDiscoveryStatus(status: DiscoveryStatus): void {
    this.phase.set(status.state);
    this.changeRef.set(status.changeRef);
    this.discoveredServerId.set(status.serverId);
    this.inventory.set(status.inventory);
    this.message.set(this.discoveryMessage(status.state, status.reason));
  }

  private discoveryMessage(state: DiscoveryStatus['state'], reason?: string): string {
    if (state === 'checking') {
      return 'Validating the server and discovering tools…';
    }
    if (reason === 'connection_required') {
      return 'A scoped validation connection is required. Protected discovery is unavailable.';
    }
    if (state === 'needs_input') return 'Pending review. These tools are blocked.';
    return 'Server rejected. The address, protocol or tool inventory did not pass validation.';
  }

  private isValidAddress(address: string): boolean {
    try {
      const url = new URL(address);
      return url.protocol === 'https:' && !url.username && !url.password
        && !url.search && !url.hash;
    } catch {
      return false;
    }
  }

  private registrationRequest(): RequestInit {
    return {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ locator: this.locator() }),
    };
  }

  private async readRegistrationReply(response: Response): Promise<{ changeRef: string }> {
    const rawReply: unknown = await response.json();
    return z.object({ changeRef: z.string() }).parse(rawReply);
  }

  private discoveryUrl(): string {
    if (this.serverId) {
      return `/api/org/integrations/${encodeURIComponent(this.serverId)}/discovery`;
    }
    return `/api/org/integrations/discovery?locator=${encodeURIComponent(this.locator())}`;
  }

  private clearOnAccessLoss(response: Response): boolean {
    if (response.status !== 401 && response.status !== 403) return false;
    this.inventory.set(undefined);
    this.changeRef.set('');
    this.locator.set('');
    this.discoveredServerId.set('');
    sessionStorage.removeItem('mcp-registration');
    this.phase.set('access');
    this.message.set('You no longer have permission. Ask an Owner or Admin.');
    globalThis.setTimeout(this.focusAccessHeading, 0);
    return true;
  }

  private setUnknown(): void {
    this.phase.set('unknown');
    this.message.set('We could not confirm the change. Check status before continuing.');
  }

  private focusStatus = (): void => {
    globalThis.setTimeout(this.focusMcpStatus, 0);
  };

  private focusMcpStatus = (): void => {
    const heading = this.document.querySelector<HTMLElement>('#add-heading');
    heading?.focus();
  };

  private focusAddress = (): void => {
    const address = this.document.querySelector<HTMLInputElement>('#remote-url');
    address?.focus();
  };

  private focusAccessHeading = (): void => {
    const heading = this.document.querySelector<HTMLElement>('#integration-access-heading');
    heading?.focus();
  };
}
