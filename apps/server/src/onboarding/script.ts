export const welcomeScripts = {
  'welcome-v1': {
    assistant: { stepId: 'weekly_help', question: 'What would make this week easier?' },
    no_assistant: { stepId: 'continue_to_workspace', question: 'Continue to workspace' },
  },
} as const;
