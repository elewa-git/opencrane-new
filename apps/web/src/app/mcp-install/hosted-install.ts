import { ChangeDetectionStrategy, Component, output, signal, type OnDestroy } from '@angular/core';
import { hostedAdmissionSchema } from '@opencrane/protocol';
import { decode, encode } from 'punycode/';
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

function normaliseHost(host: string): string {
  // Match the event store's URL check before sending a registration request.
  if (/[^\p{L}\p{N}.-]/u.test(host)) return '';
  try {
    return new URL(`https://${host}`).hostname;
  } catch {
    return '';
  }
}

function validPunycodeLabel(label: string): boolean {
  try {
    const encoded = label.slice(4);
    const decoded = decode(encoded);
    if (!/[^\p{ASCII}]/u.test(decoded)) return false;
    if (/[^\p{L}\p{M}\p{Nd}-]/u.test(decoded)) return false;
    return encode(decoded) === encoded;
  } catch {
    return false;
  }
}

function publicHost(value: string): boolean {
  if (value.length > 253 || !/^[a-z0-9.-]+$/u.test(value)) return false;
  if (normaliseHost(value) !== value) return false;
  const labels = value.split('.');
  const suffix = labels.at(-1) ?? '';
  if (labels.length < 2 || !/[a-z]/u.test(suffix)) return false;
  for (const internal of internalSuffixes) {
    if (value === internal || value.endsWith(`.${internal}`)) return false;
  }
  for (const label of labels) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label)) return false;
    // Check these labels ourselves because Chromium accepts some that Node rejects.
    if (label.startsWith('xn--') && !validPunycodeLabel(label)) return false;
  }
  return true;
}

@Component({
  selector: 'oc-hosted-install',
  templateUrl: './hosted-install.html',
  styleUrl: './hosted-install.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HostedInstall implements OnDestroy {
  readonly started = output<void>();
  readonly editing = output<void>();
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
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly currentTime = signal(Date.now());

  ngOnDestroy(): void {
    this.clearExpiryTimer();
  }

  protected editLocator(value: string): void { this.locator.set(value); }
  protected editPlatform(value: 'linux/amd64' | 'linux/arm64'): void {
    this.platform.set(value);
  }
  protected editHost(value: string): void { this.upstreamHost.set(value); }
  protected editPort(value: string): void { this.upstreamPort.set(value); }

  protected chooseAnotherVersion(): void {
    if (this.admission()?.status !== 'rejected') return;
    this.accessGeneration += 1;
    this.commandId = '';
    this.serverId = '';
    this.busy.set(false);
    this.changeRef.set('');
    this.setAdmission(undefined);
    this.locator.set('');
    this.phase.set('draft');
    this.message.set('Choose an exact image and its permitted upstream.');
    this.editing.emit();
  }

  protected alternativeLabel(): string {
    if (this.admission()?.checks?.signature.verdict === 'fail') {
      return 'Choose another signed version';
    }
    return 'Choose another version';
  }

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    if (this.phase() !== 'draft' || this.busy()) return;
    const port = Number(this.upstreamPort());
    const host = normaliseHost(this.upstreamHost());
    if (!this.validDetails(host, port)) {
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
      upstream: { host, port }, commandId: this.commandId };
    try {
      const response = await fetch('/api/org/integrations', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      if (this.lostAccess(response)) return;
      if (generation !== this.accessGeneration) return;
      if (response.status === 400) {
        this.commandId = '';
        this.phase.set('draft');
        this.message.set('The server refused these details. Please correct the package details.');
        return;
      }
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

  private validDetails(host: string, port: number): boolean {
    const platform = this.platform();
    if (!imagePattern.test(this.locator()) ||
        (platform !== 'linux/amd64' && platform !== 'linux/arm64') ||
        !publicHost(host) ||
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
        this.setAdmission(undefined);
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
    this.setAdmission(result);
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
    if (status === 'rejected') return 'Not admitted. An image check failed.';
    if (status === 'unavailable') {
      return 'A check is unavailable. The image needs a dated result for that check.';
    }
    return 'Waiting for dated check results. No scanner result has been returned.';
  }

  protected checkReason(check: Check | undefined): string | undefined {
    if (!check || check.verdict !== 'fail') return undefined;
    if (check.reasonCodes.includes('unsigned')) {
      return 'This image has no accepted publisher signature.';
    }
    if (check.reasonCodes.includes('forbidden_licence')) {
      return 'This licence is not accepted for an installed package.';
    }
    return 'The check did not accept this image.';
  }

  private allCurrent(checks: Admission['checks']): boolean {
    if (!checks) return false;
    for (const check of Object.values(checks)) {
      if (check.verdict !== 'pass' || Date.parse(check.expiresAt) <= this.currentTime()) return false;
    }
    return true;
  }

  protected checkLabel(check: Check | undefined): string {
    if (!check) return 'No result reported';
    if (check.verdict === 'not_run') return 'Not run';
    if (check.verdict === 'unavailable') return 'Unavailable';
    if (check.verdict === 'fail') return 'Failed';
    if (Date.parse(check.expiresAt) <= this.currentTime()) return 'Expired';
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

  private setAdmission(result: Admission | undefined): void {
    this.clearExpiryTimer();
    this.currentTime.set(Date.now());
    this.admission.set(result);
    if (result) this.scheduleExpiry(result);
  }

  private scheduleExpiry(result: Admission): void {
    // Wake when the next pass expires so an idle page stops showing it as current.
    if (!result.checks) return;
    let nextExpiry = Infinity;
    for (const check of Object.values(result.checks)) {
      if (check.verdict !== 'pass') continue;
      const expiry = Date.parse(check.expiresAt);
      if (expiry > this.currentTime() && expiry < nextExpiry) nextExpiry = expiry;
    }
    if (nextExpiry === Infinity) return;
    const delay = Math.max(1, nextExpiry - Date.now());
    this.expiryTimer = setTimeout(() => {
      this.currentTime.set(Date.now());
      this.message.set(this.admissionMessage(result));
      this.scheduleExpiry(result);
    }, delay);
  }

  private clearExpiryTimer(): void {
    if (this.expiryTimer === undefined) return;
    clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
  }

  private lostAccess(response: Response): boolean {
    if (response.status !== 401 && response.status !== 403) return false;
    this.accessGeneration += 1;
    this.locator.set('');
    this.upstreamHost.set('');
    this.upstreamPort.set('');
    this.setAdmission(undefined);
    this.changeRef.set('');
    this.commandId = '';
    this.serverId = '';
    this.busy.set(false);
    this.phase.set('access');
    this.message.set('You no longer have permission. Ask an Owner or Admin.');
    return true;
  }
}
