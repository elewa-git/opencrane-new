import type { conversationKeys } from '@opencrane/projections';
import type { ChatOptions } from '../chat/access.ts';

export type OnboardingOptions = ChatOptions & {
  keys: ReturnType<typeof conversationKeys>;
};
