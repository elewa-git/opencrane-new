import type { APIResponse, Page } from 'playwright';

type BrowserSession = Pick<Page, 'request'>;
type DirectReplyInspector = (method: 'GET' | 'POST', response: APIResponse) => Promise<void>;

const inspectors = new WeakMap<BrowserSession, DirectReplyInspector>();

export function inspectDirectJourneyReplies(page: BrowserSession,
  inspect: DirectReplyInspector): void {
  inspectors.set(page, inspect);
}

// Keep the browser session and send each direct request on a fresh connection.
// A port forward can report an idle connection's closure after the next request starts.
export async function readJourneyApi(page: BrowserSession, url: string) {
  const inspect = inspectors.get(page);
  const redirects = inspect ? { maxRedirects: 0 } : {};
  const options = { headers: { connection: 'close' }, ...redirects };
  const response = await page.request.get(url, options);
  await inspect?.('GET', response);
  return response;
}

export async function postJourneyCommand(page: BrowserSession, origin: string, path: string,
  data: unknown) {
  const inspect = inspectors.get(page);
  const headers = { origin, connection: 'close' };
  const redirects = inspect ? { maxRedirects: 0 } : {};
  const options = { headers, data, ...redirects };
  const response = await page.request.post(`${origin}${path}`, options);
  await inspect?.('POST', response);
  return response;
}
