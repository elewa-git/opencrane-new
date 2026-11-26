export function fixtureElement(fixture: { nativeElement: unknown }): HTMLElement {
  const element = fixture.nativeElement;
  if (!(element instanceof HTMLElement)) {
    throw new Error('Expected a Models element');
  }
  return element;
}

export function findButton(element: HTMLElement, label: string): HTMLButtonElement | undefined {
  function hasLabel(button: HTMLButtonElement): boolean {
    return button.textContent?.trim() === label;
  }
  const buttons = Array.from(element.querySelectorAll('button'));
  return buttons.find(hasLabel);
}

export function requiredButton(element: HTMLElement, label: string): HTMLButtonElement {
  const button = findButton(element, label);
  if (!button) {
    throw new Error(`Missing button: ${label}`);
  }
  return button;
}
