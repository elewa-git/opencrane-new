export function execToolCall(command: string, example: string) {
  const argumentsValue = { cmd: command, max_output_tokens: 100 };
  const argumentsText = JSON.stringify(argumentsValue);
  const input = `text(await tools.exec_command(${argumentsText}))`;
  return {
    type: 'custom_tool_call',
    id: `ct_${example}`,
    status: 'completed',
    name: 'exec',
    call_id: `call_${example}`,
    input,
  };
}
