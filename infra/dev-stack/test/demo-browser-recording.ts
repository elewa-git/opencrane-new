import { readFile } from 'node:fs/promises';
import type { Browser, Page, Request } from 'playwright';

export function browserRecording(interruptAtLimit = false, failWarm = false) {
  let closed = false;
  let pending: (() => void) | undefined;
  let submitted = 0;
  const listeners = new Set<(request: Request) => void>();
  function check() {
    if (closed) {
      throw new Error('Recording browser closed');
    }
  }
  async function close() {
    closed = true;
    pending?.();
  }
  function page() {
    let location = '';
    let prompt = '';
    async function goto(url: string) {
      check();
      location = url;
    }
    function url() {
      return location;
    }
    async function nothing() {
      check();
    }
    async function click() {
      check();
      if (location.endsWith('/workspace/shared')) {
        location = location.replace('/workspace/shared', '/workspace?conversation=shared');
      }
    }
    async function fill(value: string) {
      check();
      prompt = value;
    }
    async function press() {
      check();
      submitted += 1;
      function requestUrl() {
        return `${new URL(location).origin}/api/conversations/demo/messages`;
      }
      function method() {
        return 'POST';
      }
      function postDataJSON() {
        return { id: `turn-${submitted}`, text: prompt };
      }
      const request = { url: requestUrl, method, postDataJSON } as Request;
      for (const listener of listeners) listener(request);
      if (prompt.startsWith('Limit demonstration') && interruptAtLimit) {
        process.send?.('limit');
        function wait(resolve: () => void) {
          pending = resolve;
        }
        await new Promise<void>(wait);
        check();
      }
      if (failWarm) {
        throw new Error('Synthetic private warm-up failure');
      }
    }
    async function innerText() {
      check();
      return 'ready 437 Paris 1,234.56 17 November 2026';
    }
    async function count() {
      check();
      return 1;
    }
    async function inputValue() {
      check();
      return '1';
    }
    async function getAttribute() {
      check();
      return '/supplier.pdf';
    }
    function locator() {
      check();
      return element;
    }
    const element = {
      fill,
      press,
      innerText,
      count,
      inputValue,
      getAttribute,
      waitFor: nothing,
      click,
      first: locator,
      nth: locator,
      filter: locator,
      getByRole: locator,
      getByText: locator,
      locator,
    };
    async function newPage() {
      check();
      return page();
    }
    function on(_event: string, listener: (request: Request) => void) {
      listeners.add(listener);
    }
    function off(_event: string, listener: (request: Request) => void) {
      listeners.delete(listener);
    }
    function context() {
      return { newPage, on, off };
    }
    function frameUrl() {
      return 'chrome-extension://pdf';
    }
    function frames() {
      return [{ url: frameUrl, getByRole: locator }];
    }
    async function body() {
      return readFile('infra/dev-stack/fixtures/supplier.pdf');
    }
    function status() {
      return 200;
    }
    async function json() {
      return { rows: [{ memberId: 'zitadel-owner' }] };
    }
    async function get() {
      return { status, body, json };
    }
    function setDefaultTimeout() {
      check();
    }
    // Keep Page as the external browser boundary. Every method stays in this recording.
    const request = { get };
    return {
      goto,
      url,
      context,
      frames,
      getByRole: locator,
      getByText: locator,
      locator,
      waitForLoadState: nothing,
      reload: nothing,
      screenshot: nothing,
      close: nothing,
      setViewportSize: nothing,
      setDefaultTimeout,
      request,
    } as unknown as Page;
  }
  const ownerPage = page();
  const memberPages = [page()];
  const browser = { close } as unknown as Browser;
  function callCount() { return submitted; }
  return { browser, ownerPage, memberPages, callCount };
}
