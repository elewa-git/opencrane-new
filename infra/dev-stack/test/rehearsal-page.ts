import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';

export class RehearsalPage {
  limited = false;
  refusalMissing = true;
  width = 1280;
  invitationEmail = '';
  invitationEmails = new Set<string>();
  enteredValues: Array<{ width: number; selector: string; value: string }> = [];
  historyInView = '';
  pictures: Array<{ path: string; historyInView: string }> = [];
  restoreAttempted = false;
  address = 'https://rehearsal.example.invalid/workspace?conversation=fixture';
  keyboard = { press: this.ignore };
  request = { get: this.response };

  async ignore() {}

  async response() {
    const supplier = new URL('../fixtures/supplier.pdf', import.meta.url);
    const bytes = await readFile(supplier);
    function status() {
      return 200;
    }
    async function body() {
      return bytes;
    }
    async function json() {
      return { rows: [
        { memberId: 'zitadel-owner' }, { memberId: 'zitadel-member' },
        { memberId: 'jente-rosseel' },
      ] };
    }
    return { status, body, json };
  }

  async setViewportSize(viewport: { width: number }) {
    this.width = viewport.width;
  }

  async screenshot(settings: { path: string }) {
    const picture = { path: settings.path, historyInView: this.historyInView };
    this.pictures.push(picture);
    await writeFile(settings.path, 'Synthetic picture fixture');
  }
  setDefaultTimeout = this.ignore;
  reload = this.ignore;
  waitForLoadState = this.ignore;

  async goto(address: string) {
    this.address = `${address}?conversation=fixture`;
  }

  url() {
    return this.address;
  }

  frames() {
    const page = this;
    function url() {
      return 'chrome-extension://pdf-viewer';
    }
    function getByRole() {
      return page.locator('Page number');
    }
    return [{ url, getByRole }];
  }

  async waitForEvent() {
    return { setFiles: this.ignore };
  }

  locator(selector: string) {
    return new RehearsalLocator(this, selector);
  }

  getByRole(role: string, options?: { name?: string | RegExp }) {
    return this.locator(String(options?.name ?? role));
  }

  getByText(text: string | RegExp) {
    return this.locator(String(text));
  }

  getByLabel(label: string) {
    return this.locator(label);
  }
}

class RehearsalLocator {
  readonly page: RehearsalPage;
  readonly selector: string;

  constructor(page: RehearsalPage, selector: string) {
    this.page = page;
    this.selector = selector;
  }

  async fill(value: string) {
    const entry = { width: this.page.width, selector: this.selector, value };
    this.page.enteredValues.push(entry);
    if (this.selector === 'Person email') {
      this.page.invitationEmail = value;
    }
  }

  async press() {}

  async selectOption() {}

  async waitFor() {
    if (this.selector === '/limit reached/iu' && this.page.refusalMissing) {
      throw new Error('Original refusal missing sk-synthetic-fixture-value');
    }
  }

  async click() {
    if (this.selector === 'Create') {
      assert(!this.page.invitationEmails.has(this.page.invitationEmail),
        'Invitation email already exists');
      this.page.invitationEmails.add(this.page.invitationEmail);
    }
    if (this.selector === 'Save budget') {
      this.page.limited = true;
    }
    if (this.selector === 'Start session') {
      this.page.address = 'https://rehearsal.example.invalid/workspace?conversation=private';
    }
  }

  async count() {
    if (this.selector.includes('password') || this.selector === 'Reply failed') {
      return 0;
    }
    return 1;
  }

  async inputValue() {
    return '1';
  }

  async scrollIntoViewIfNeeded() {
    this.page.historyInView = this.selector;
  }

  async innerText() {
    if (this.selector === 'oc-audit') {
      return 'budget.ceiling_set team.created';
    }
    return '437 1,234.56 17 November 2026 Paris Stopped reply';
  }

  async getAttribute() {
    return '/supplier.pdf';
  }

  first() {
    return this;
  }

  nth() {
    return this;
  }

  filter(options: { hasText?: string | RegExp; has?: unknown }) {
    return this.page.locator(`${this.selector} ${String(options.hasText ?? '')}`);
  }

  locator(selector: string) {
    return this.page.locator(selector);
  }

  getByRole(role: string, options?: { name?: string | RegExp }) {
    return this.page.getByRole(role, options);
  }

  getByText(text: string | RegExp) {
    return this.page.getByText(text);
  }
}
