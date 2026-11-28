import { execToolCall } from './exec-tool-call.ts';

export const chatLinksPrompt = 'CHAT_LINKS_PROOF';

const longAddress = 'https://example.test/' + 'long-address-'.repeat(20);
export const chatLinksText = 'Visit https://example.test/guide., www.example.test/help)? '
  + 'or help@example.test!\n\n'
  + '/workspace/artifacts/link-proof.txt\n'
  + 'file:///workspace/artifacts/link-proof.txt\n'
  + '[Shared file](/workspace/artifacts/link-proof.txt)\n'
  + '[Shared file URL](file:///workspace/artifacts/link-proof.txt)\n'
  + '[Preferences](/account/preferences)\n\n'
  + 'javascript:alert data:text/html,hello http://example.test unknown:address\n\n'
  + '`https://example.test/code`\n\n```text\nwww.example.test/code\n```\n\n'
  + longAddress;

export function chatLinksFileCall() {
  // Use the computer's ordinary file publication so the browser checks real shared-file access.
  const command = "mkdir -p /workspace/artifacts && printf 'A shared file for the link check.\\n' "
    + '> /workspace/artifacts/link-proof.txt';
  return execToolCall(command, 'chat_links');
}
