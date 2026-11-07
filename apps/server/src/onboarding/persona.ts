import { memoryTextSchema, surveyAnswersSchema } from '@opencrane/events';
import type { ChatOptions } from '../chat/access.ts';
import { decryptAnswers, type surveyHistory } from './history.ts';

function labelled(label: string, value: unknown) {
  // Keep member answers labelled and JSON-escaped; the renderer never runs their instructions.
  return `${label}: ${JSON.stringify(value)}`;
}

export function checkedPersona(value: string) {
  return memoryTextSchema.parse(value);
}

export function renderPersona(options: ChatOptions, memberId: string,
  history: Awaited<ReturnType<typeof surveyHistory>>) {
  if (history.steps.length !== 4) throw new Error('Incomplete survey');
  const answers = [];
  for (const row of history.steps) {
    const opened = decryptAnswers(options, memberId, row.event);
    answers.push(surveyAnswersSchema.parse(opened));
  }
  const [name, work, style, tasks] = answers;
  const lines = [
    '# Personal assistant persona',
    labelled('Preferred name', name),
    labelled('Work', work),
    labelled('Style', style),
    labelled('Desired tasks', tasks),
    'Language: follow the member\'s language unless they ask otherwise.',
    'Challenge: ask when a request is unclear.',
    'Initiative: suggest the next useful step, then wait for permission to act.',
    'Habits: none specified.',
    'Memory: remember only through the authorised memory process.',
    'Risk: access, tool and spending rules always apply.',
  ];
  return checkedPersona(lines.join('\n'));
}
