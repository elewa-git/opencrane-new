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
  const argumentsText = JSON.stringify({ cmd: command, max_output_tokens: 100 });
  const input = `text(await tools.exec_command(${argumentsText}))`;
  return { type: 'custom_tool_call', id: 'ct_chat_links', status: 'completed',
    name: 'exec', call_id: 'call_chat_links', input };
}
