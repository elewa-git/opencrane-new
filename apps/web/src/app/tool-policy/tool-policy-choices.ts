import type { ToolPolicy } from '@opencrane/protocol';

type Tool = ToolPolicy['tools'][number];
export type ToolChoice = { mode: Tool['mode']; revision: string };

export function choicesForCurrentTools(
  previousPolicy: ToolPolicy | undefined,
  previousChoices: Map<string, ToolChoice>,
  currentPolicy: ToolPolicy,
): Map<string, ToolChoice> {
  if (!previousPolicy) return new Map();
  const keptChoices = new Map<string, ToolChoice>();
  for (const previousTool of previousPolicy.tools) {
    const choice = previousChoices.get(previousTool.name);
    if (!choice) continue;
    const currentTool = currentPolicy.tools.find(hasName(previousTool.name));
    if (!currentTool || !currentTool.reviewed || currentTool.revision !== choice.revision) continue;
    keptChoices.set(currentTool.name, choice);
  }
  return keptChoices;
}

export function choicesWithout(
  choices: Map<string, ToolChoice>,
  toolName: string,
): Map<string, ToolChoice> {
  const remainingChoices = new Map(choices);
  remainingChoices.delete(toolName);
  return remainingChoices;
}

export function choicesDifferentFromSaved(
  choices: Map<string, ToolChoice>,
  policy: ToolPolicy,
): Map<string, ToolChoice> {
  const keptChoices = new Map<string, ToolChoice>();
  for (const [toolName, choice] of choices) {
    const tool = policy.tools.find(hasName(toolName));
    if (!tool || !tool.reviewed || tool.revision !== choice.revision) continue;
    if (tool.mode === choice.mode) continue;
    keptChoices.set(toolName, choice);
  }
  return keptChoices;
}

function hasName(name: string): (tool: Tool) => boolean {
  return (tool) => tool.name === name;
}
