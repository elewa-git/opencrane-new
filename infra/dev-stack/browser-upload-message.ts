import type { Page } from 'playwright';

export async function sendUploadedMessage(page: Page, text: string, expectedReply: string) {
  const replies = page.getByRole('article', { name: 'Agent reply', exact: true });
  const previousReplies = await replies.count();
  const composer = page.getByRole('textbox', { name: 'Message your agent' });
  await composer.fill(text);
  const send = page.getByRole('button', { name: 'Send message', exact: true });
  await send.click();
  // Send can remain visible until the command is acknowledged and its reply starts.
  const reply = replies.nth(previousReplies);
  const expected = reply.filter({ hasText: expectedReply });
  const done = expected.getByText('Done', { exact: true });
  await done.waitFor({ timeout: 120_000 });
}
