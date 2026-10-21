import { readFile } from 'node:fs/promises';
import type { Browser, Page } from 'playwright';

export function browserRecording(interruptAtLimit = false, failWarm = false) {
  let closed = false;
  let pending: (() => void) | undefined;
  let submitted = 0;
  function check() {
    if (closed) throw new Error('Recording browser closed');
  }
  async function close() {
    closed = true;
    pending?.();
  }
  function page() {
    let location = '';
    let prompt = '';
    async function goto(url: string) { check(); location = url; }
    function url() { return location; }
    async function nothing() { check(); }
    async function fill(value: string) { check(); prompt = value; }
    async function press() {
      check();
      submitted += 1;
      if (prompt.startsWith('Limit demonstration') && interruptAtLimit) {
        process.send?.('limit');
        function wait(resolve: () => void) { pending = resolve; }
        await new Promise<void>(wait);
        check();
      }
      if (failWarm) throw new Error('Synthetic private warm-up failure');
    }
    async function innerText() { check(); return 'ready 437 Paris 1,234.56 17 November 2026'; }
    async function count() { check(); return 1; }
    async function inputValue() { check(); return '1'; }
    async function getAttribute() { check(); return '/supplier.pdf'; }
    function locator() { check(); return element; }
    const element = { fill, press, innerText, count, inputValue, getAttribute,
      waitFor: nothing, click: nothing, first: locator, last: locator, filter: locator,
      getByRole: locator, getByText: locator, locator };
    async function newPage() { check(); return page(); }
    function context() { return { newPage }; }
    function frameUrl() { return 'chrome-extension://pdf'; }
    function frames() { return [{ url: frameUrl, getByRole: locator }]; }
    async function body() { return readFile('infra/dev-stack/fixtures/supplier.pdf'); }
    function status() { return 200; }
    async function get() { return { status, body }; }
    function setDefaultTimeout() { check(); }
    // Keep Page as the external browser boundary. Every method stays in this recording.
    return { goto, url, context, frames, getByRole: locator, getByText: locator, locator,
      reload: nothing, screenshot: nothing, close: nothing, setViewportSize: nothing,
      setDefaultTimeout, request: { get } } as unknown as Page;
  }
  const ownerPage = page();
  const memberPages = [page()];
  const browser = { close } as unknown as Browser;
  function callCount() { return submitted; }
  return { browser, ownerPage, memberPages, callCount };
}
