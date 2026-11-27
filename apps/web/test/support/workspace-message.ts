import type { ComponentFixture } from '@angular/core/testing';
import type { Workspace } from '../../src/app/chat/workspace';

export interface WorkspaceMessageCapture {
  root: HTMLElement;
  fixture: ComponentFixture<Workspace>;
}

export function typeWorkspaceMessage(
  capture: WorkspaceMessageCapture, text: string,
): HTMLTextAreaElement {
  const field = capture.root.querySelector<HTMLTextAreaElement>('#message')!;
  field.value = text;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  capture.fixture.detectChanges();
  return field;
}
