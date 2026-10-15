import { ChangeDetectionStrategy, Component, output, signal } from '@angular/core';
import { hostedAdmissionSchema } from '@opencrane/protocol';
import { z } from 'zod';

type Admission = z.infer<typeof hostedAdmissionSchema>;
type Check = NonNullable<Admission['checks']>[keyof NonNullable<Admission['checks']>];
const registrationReply = z.object({ serverId: z.string(), changeRef: z.string() });
const changeReply = z.object({ status: z.enum(['applied', 'unknown']), serverId: z.string().optional() });
const imageRegistry = '(?:localhost|(?:[a-z0-9-]+\\.)+[a-z0-9-]+)(?::[0-9]{1,5})?';
const imageName = '[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*';
const imagePattern = new RegExp(
  `^${imageRegistry}(?:/${imageName})+@sha256:[a-f0-9]{64}$`, 'u');
const internalSuffixes = ['localhost', 'local', 'internal', 'lan', 'home', 'svc',
  'test', 'invalid', 'example', 'onion', 'home.arpa'];

function publicHost(value: string): boolean {
  if (value.length > 253 || !/^[a-z0-9.-]+$/u.test(value)) return false;
  const labels = value.split('.');
  const suffix = labels.at(-1) ?? '';
  if (labels.length < 2 || !/[a-z]/u.test(suffix)) return false;
  for (const internal of internalSuffixes) {
    if (value === internal || value.endsWith(`.${internal}`)) return false;
  }
  for (const label of labels) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label)) return false;
  }
  return true;
}

@Component({
  selector: 'oc-hosted-install',
  templateUrl: './hosted-install.html',
  styleUrl: './hosted-install.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HostedInstall {
  readonly started = output<void>();
  protected readonly locator = signal('');
  protected readonly platform = signal<'linux/amd64' | 'linux/arm64'>('linux/amd64');
  protected readonly upstreamHost = signal('');
  protected readonly upstreamPort = signal('443');
  protected readonly phase = signal<'draft' | 'checking' | 'unknown' | 'queued' | 'access'>('draft');
  protected readonly busy = signal(false);
  protected readonly message = signal('Choose an exact image and its permitted upstream.');
  protected readonly admission = signal<Admission | undefined>(undefined);
  protected readonly changeRef = signal('');
  private commandId = '';
  private serverId = '';
  private accessGeneration = 0;

  protected editLocator(value: string): void { this.locator.set(value); }
  protected editPlatform(value: 'linux/amd64' | 'linux/arm64'): void {
    this.platform.set(value);
  }
  protected editHost(value: string): void { this.upstreamHost.set(value); }
  protected editPort(value: string): void { this.upstreamPort.set(value); }

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    if (this.phase() !== 'draft' || this.busy()) return;
    const port = Number(this.upstreamPort());
    if (!this.validDetails(port)) {
      this.message.set('Enter a sha256 image digest, a public upstream host and a port from 1 to 65535.');
      return;
    }
    this.commandId = crypto.randomUUID();
    this.started.emit();
    this.phase.set('checking');
    this.busy.set(true);
    this.message.set('Sending the package for admission checks…');
    const generation = this.accessGeneration;
    const body = { kind: 'hosted', locator: this.locator(), platform: this.platform(),
      upstream: { host: this.upstreamHost(), port }, commandId: this.commandId };
    try {
      const response = await fetch('/api/org/integrations', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      if (this.lostAccess(response)) return;
      if (generation !== this.accessGeneration) return;
      if (!response.ok) {
        this.unknownOutcome();
        return;
      }
      const raw: unknown = await response.json();
      const result = registrationReply.parse(raw);
      if (generation !== this.accessGeneration) return;
      this.serverId = result.serverId;
      this.changeRef.set(result.changeRef);
      this.phase.set('queued');
      this.message.set('Registration saved. Check status for the admission queue.');
    } catch {
      if (generation === this.accessGeneration) this.unknownOutcome();
    } finally {
      if (generation === this.accessGeneration) this.busy.set(false);
    }
  }

  private validDetails(port: number): boolean {
    const platform = this.platform();
    if (!imagePattern.test(this.locator()) ||
        (platform !== 'linux/amd64' && platform !== 'linux/arm64') ||
        !publicHost(this.upstreamHost()) ||
        !Number.isInteger(port) || port < 1 || port > 65535) {
      return false;
    }
    return true;
  }

  protected async checkStatus(): Promise<void> {
    if (this.busy() || this.phase() === 'access' || !this.commandId) return;
    this.busy.set(true);
    const generation = this.accessGeneration;
    try {
      if (!this.serverId) {
        await this.readOriginalChange(generation);
      } else {
        await this.readAdmission(generation);
      }
    } catch {
      if (generation === this.accessGeneration) {
        this.admission.set(undefined);
        this.message.set('Status is unavailable. Check status again when the service responds.');
      }
    } finally {
      if (generation === this.accessGeneration) this.busy.set(false);
    }
  }

  private async readOriginalChange(generation: number): Promise<void> {
    const response = await fetch(`/api/org/integrations/changes/${encodeURIComponent(this.commandId)}`);
    if (this.lostAccess(response) || generation !== this.accessGeneration) return;
    if (!response.ok) throw new Error('Change status unavailable');
    const raw: unknown = await response.json();
    const result = changeReply.parse(raw);
    if (generation !== this.accessGeneration) return;
    if (result.status !== 'applied' || !result.serverId) {
      this.unknownOutcome();
      return;
    }
    this.serverId = result.serverId;
    this.phase.set('queued');
    this.message.set('Registration saved. Check status for the admission queue.');
  }

  private async readAdmission(generation: number): Promise<void> {
    const response = await fetch(`/api/org/integrations/${encodeURIComponent(this.serverId)}/admission`);
    if (this.lostAccess(response) || generation !== this.accessGeneration) return;
    if (!response.ok) throw new Error('Admission unavailable');
    const raw: unknown = await response.json();
    const result = hostedAdmissionSchema.parse(raw);
    if (generation !== this.accessGeneration) return;
    this.admission.set(result);
    this.phase.set('queued');
    this.message.set(this.admissionMessage(result));
  }

  private admissionMessage(result: Admission): string {
    const status = result.status;
    if (status === 'admitted' && this.allCurrent(result.checks)) {
      return 'All four image checks passed. Discovery is unavailable.';
    }
    if (status === 'admitted') return 'Current image checks are unavailable. Discovery is unavailable.';
    if (status === 'expired') return 'The image checks have expired. Discovery is unavailable.';
    if (status === 'rejected') return 'An image check failed. Discovery is unavailable.';
    if (status === 'unavailable') return 'An image check is unavailable. Discovery is unavailable.';
    return 'The image is queued for checks. Discovery is unavailable.';
  }

  private allCurrent(checks: Admission['checks']): boolean {
    if (!checks) return false;
    for (const check of Object.values(checks)) {
      if (check.verdict !== 'pass' || Date.parse(check.expiresAt) <= Date.now()) return false;
    }
    return true;
  }

  protected checkLabel(check: Check | undefined): string {
    if (!check) return 'No result reported';
    if (check.verdict === 'not_run') return 'Not run';
    if (check.verdict === 'unavailable') return 'Unavailable';
    if (check.verdict === 'fail') return 'Failed';
    if (Date.parse(check.expiresAt) <= Date.now()) return 'Expired';
    return 'Passed';
  }

  protected checkDate(check: Check | undefined): string | undefined {
    if (!check || check.verdict === 'not_run') return undefined;
    return this.date(check.checkedAt);
  }

  protected date(value: string | undefined): string {
    if (!value) return 'No date reported';
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return 'No date reported';
    return `${parsed.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', timeZone: 'UTC', hourCycle: 'h23' })} UTC`;
  }

  private unknownOutcome(): void {
    this.phase.set('unknown');
    this.message.set('The registration outcome is unknown. Check status for this request.');
  }

  private lostAccess(response: Response): boolean {
    if (response.status !== 401 && response.status !== 403) return false;
    this.accessGeneration += 1;
    this.locator.set('');
    this.upstreamHost.set('');
    this.upstreamPort.set('');
    this.admission.set(undefined);
    this.changeRef.set('');
    this.commandId = '';
    this.serverId = '';
    this.busy.set(false);
    this.phase.set('access');
    this.message.set('You no longer have permission. Ask an Owner or Admin.');
    return true;
  }
}
