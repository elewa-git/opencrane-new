function showModal(this: HTMLDialogElement): void {
  this.setAttribute('open', '');
}

function closeModal(this: HTMLDialogElement): void {
  this.removeAttribute('open');
}

function restoreMethod(prototype: HTMLDialogElement, name: 'showModal' | 'close',
  descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) {
    Object.defineProperty(prototype, name, descriptor);
  } else {
    Reflect.deleteProperty(prototype, name);
  }
}

export function memoryDialogFixture() {
  const prototype = HTMLDialogElement.prototype;
  let showDescriptor: PropertyDescriptor | undefined;
  let closeDescriptor: PropertyDescriptor | undefined;

  function install(): void {
    // Restore the host's methods after each test because Angular can reuse the DOM.
    showDescriptor = Object.getOwnPropertyDescriptor(prototype, 'showModal');
    closeDescriptor = Object.getOwnPropertyDescriptor(prototype, 'close');
    const methods = {
      showModal: { configurable: true, writable: true, value: showModal },
      close: { configurable: true, writable: true, value: closeModal },
    };
    Object.defineProperties(prototype, methods);
  }

  function restore(): void {
    restoreMethod(prototype, 'showModal', showDescriptor);
    restoreMethod(prototype, 'close', closeDescriptor);
  }

  return { install, restore };
}
