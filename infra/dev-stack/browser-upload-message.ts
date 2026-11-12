import type { Page } from 'playwright';

export async function sendUploadedMessage(page: Page, text: string, expectedReply: string) {
  const composer = page.getByRole('textbox', { name: 'Message your agent' });
  await composer.fill(text);
  const send = page.getByRole('button', { name: 'Send message', exact: true });
  await send.click();
  await send.waitFor();
}
