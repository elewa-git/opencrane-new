export function pageHasNoOverflow() {
  const documentWidth = globalThis.document.documentElement.scrollWidth;
  const viewportWidth = globalThis.window.innerWidth;
  return documentWidth <= viewportWidth;
}

export function outline(node) {
  const style = globalThis.getComputedStyle(node);
  return [style.outlineWidth, style.outlineColor, style.outlineOffset];
}

export async function waitForFonts() {
  await globalThis.document.fonts.ready;
}
