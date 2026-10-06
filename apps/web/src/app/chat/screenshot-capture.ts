import { Injectable, signal, type OnDestroy } from '@angular/core';
import type { ChatAttachment } from './chat-state';
import { utcDateTime } from './file-presentation';
import type { PresentationState } from '../shared-state/shared-state';

const FAILED_SCREENSHOT_DETAIL = 'The server reported that it could not save the screenshot. '
  + 'Trying again repeats the same request, so it cannot make a second copy.';
const UNKNOWN_SCREENSHOT_DETAIL = "We couldn't tell whether it was recorded. "
  + 'Check its status before sending again. Reference:';

export type CaptureState =
  | { phase: 'idle' }
  | { phase: 'saving'; commandId: string }
  | { phase: 'saved'; fileId: string; repeated: boolean }
  | { phase: 'rejected'; fileId: string; answeredAt: string }
  | { phase: 'failed'; commandId: string; answeredAt: string; sameKeyRetry: boolean }
  | { phase: 'access_changed'; answeredAt: string; signIn: boolean }
  | {
    phase: 'unknown'; commandId: string; startedAt: string;
    checkedAt?: string; checkFailedAt?: string;
  };

export interface CaptureViewModel {
  kind: PresentationState;
  message: string;
  detail: string;
  evidenceAt?: string;
  timestamp?: string;
  safeToRetry: boolean;
  repeatAvailable: boolean;
}

@Injectable()
export class ScreenshotCapture implements OnDestroy {
  readonly state = signal<CaptureState>({ phase: 'idle' });
  private abort = new AbortController();
  private requestNumber = 0;

  async start(conversationId: string, knownScreenshotIds: string[]): Promise<void> {
    const state = this.state();
    if (state.phase === 'saving') return;
    if (state.phase === 'unknown' && !state.checkedAt) return;
    const commandId = crypto.randomUUID();
    await this.send(commandId, conversationId, knownScreenshotIds);
  }

  async repeat(conversationId: string, knownScreenshotIds: string[]): Promise<void> {
    const state = this.state();
    if (state.phase === 'saving') return;
    if (state.phase === 'unknown' && !state.checkedAt) return;
    if (state.phase === 'unknown' || (state.phase === 'failed' && state.sameKeyRetry)) {
      await this.send(state.commandId, conversationId, knownScreenshotIds);
    }
  }

  markChecked(startedAt: string): void {
    const state = this.state();
    if (state.phase === 'unknown' && state.startedAt === startedAt) {
      const checkedState = { ...state, checkedAt: new Date().toISOString() };
      delete checkedState.checkFailedAt;
      this.state.set(checkedState);
    }
  }

  markCheckFailed(startedAt: string): void {
    const state = this.state();
    if (state.phase === 'unknown' && state.startedAt === startedAt) {
      const failedState = { ...state, checkFailedAt: new Date().toISOString() };
      delete failedState.checkedAt;
      this.state.set(failedState);
    }
  }

  reset(): void {
    this.requestNumber++;
    this.abort.abort();
    this.abort = new AbortController();
    this.state.set({ phase: 'idle' });
  }

  ngOnDestroy(): void {
    this.reset();
  }

  private async send(
    commandId: string,
    conversationId: string,
    knownScreenshotIds: string[],
  ): Promise<void> {
    const requestNumber = ++this.requestNumber;
    const knownIds = [...knownScreenshotIds];
    this.state.set({ phase: 'saving', commandId });
    try {
      const response = await fetch(
        `/api/conversations/${encodeURIComponent(conversationId)}/screenshots`,
        {
          method: 'POST',
          headers: { 'x-opencrane-view': '1', 'idempotency-key': commandId },
          signal: AbortSignal.any([
            this.abort.signal,
            AbortSignal.timeout(90_000),
          ]),
        },
      );
      const answeredAt = new Date().toISOString();
      const result = await readReply(response);
      if (requestNumber !== this.requestNumber) return;
      this.applyReply(commandId, response.status, result, answeredAt, knownIds);
    } catch {
      if (requestNumber !== this.requestNumber) return;
      this.state.set({ phase: 'unknown', commandId, startedAt: new Date().toISOString() });
    }
  }

  private applyReply(
    commandId: string,
    status: number,
    result: CaptureReply,
    answeredAt: string,
    knownIds: string[],
  ): void {
    if (status === 201) {
      if (result.status === 'appended' && result.fileId !== undefined) {
        this.state.set({
          phase: 'saved',
          fileId: result.fileId,
          repeated: knownIds.includes(result.fileId),
        });
        return;
      }
      this.state.set({ phase: 'unknown', commandId, startedAt: answeredAt });
      return;
    }
    if (status === 422) {
      this.state.set({ phase: 'rejected', fileId: result.fileId ?? '', answeredAt });
      return;
    }
    if (status === 401 || status === 403) {
      this.state.set({ phase: 'access_changed', answeredAt, signIn: status === 401 });
      return;
    }
    if (status === 503) {
      this.state.set({ phase: 'failed', commandId, answeredAt, sameKeyRetry: true });
      return;
    }
    this.state.set({ phase: 'failed', commandId, answeredAt, sameKeyRetry: false });
  }
}

type CaptureReply = { status?: string; fileId?: string };

async function readReply(response: Response): Promise<CaptureReply> {
  try {
    const value: unknown = await response.json();
    if (!isRecord(value)) return {};
    const reply: CaptureReply = {};
    if (typeof value['status'] === 'string') reply.status = value['status'];
    if (typeof value['fileId'] === 'string') reply.fileId = value['fileId'];
    return reply;
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function captureView(
  state: CaptureState,
  attachments: ChatAttachment[],
): CaptureViewModel | undefined {
  if (state.phase === 'idle') return undefined;
  if (state.phase === 'saving') {
    return view('applying', 'Capturing and saving screenshot…', '', false, false);
  }
  if (state.phase === 'saved') {
    const attachment = attachments.find(findAttachmentById.bind(undefined, state.fileId));
    const message = state.repeated ? 'Screenshot already saved' : 'Screenshot saved';
    const detail = state.repeated
      ? 'The repeated request returned the same file.'
      : 'It is in this conversation and in Files.';
    const result = view('confirmed', message, detail, false, false);
    const evidenceAt = attachment?.screenshot?.capturedAt;
    if (evidenceAt) result.evidenceAt = evidenceAt;
    return result;
  }
  if (state.phase === 'rejected') {
    return { ...view('refused', 'Screenshot rejected',
      'The security scan refused this image. Nothing was saved.', false, false),
    timestamp: state.answeredAt };
  }
  if (state.phase === 'failed') {
    const detail = state.sameKeyRetry
      ? FAILED_SCREENSHOT_DETAIL
      : 'Take a new screenshot to try again.';
    return { ...view('failed', "Screenshot wasn't saved", detail,
      state.sameKeyRetry, false), timestamp: state.answeredAt };
  }
  if (state.phase === 'access_changed') {
    const detail = state.signIn
      ? 'Sign in again to take screenshots.'
      : 'Ask the desktop owner for access. Check Files to see whether this screenshot was saved.';
    return { ...view('access_changed', 'Screenshot access changed', detail, false, false),
      timestamp: state.answeredAt };
  }
  return unknownCaptureView(state);
}

function unknownCaptureView(
  state: Extract<CaptureState, { phase: 'unknown' }>,
): CaptureViewModel {
  if (state.checkedAt) {
    return view('unknown', 'Screenshot outcome unknown',
      checkedUnknownDetail(state.checkedAt, state.commandId), false, true);
  }
  if (state.checkFailedAt) {
    const failedAt = utcDateTime(state.checkFailedAt);
    return view('unknown', `Could not read Files at ${failedAt}.`,
      `Check status again when the connection returns. Reference: ${state.commandId}.`,
      false, false);
  }
  return view('unknown', 'Screenshot outcome unknown',
    `${UNKNOWN_SCREENSHOT_DETAIL} ${state.commandId}.`, false, false);
}

function checkedUnknownDetail(checkedAt: string, commandId: string): string {
  const readTime = utcDateTime(checkedAt);
  return `Files read again at ${readTime}. If your screenshot is not there, send the same `
    + `request again. It cannot make a second copy. Reference: ${commandId}.`;
}

function findAttachmentById(fileId: string, attachment: ChatAttachment): boolean {
  return attachment.fileId === fileId;
}

function view(
  kind: PresentationState,
  message: string,
  detail: string,
  safeToRetry: boolean,
  repeatAvailable: boolean,
): CaptureViewModel {
  return { kind, message, detail, safeToRetry, repeatAvailable };
}
