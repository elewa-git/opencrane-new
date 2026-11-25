import type { Page } from 'playwright';

type BrowserSession = Pick<Page, 'request'>;

// Keep the browser session and send each direct request on a fresh connection.
// A port forward can report an idle connection's closure after the next request starts.
export function readJourneyApi(page: BrowserSession, url: string) {
  return page.request.get(url, { headers: { connection: 'close' } });
}

export function postJourneyCommand(page: BrowserSession, origin: string, path: string,
  data: unknown) {
  const headers = { origin, connection: 'close' };
  return page.request.post(`${origin}${path}`, { headers, data });
}
