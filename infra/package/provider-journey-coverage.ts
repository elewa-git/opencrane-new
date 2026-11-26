import type { Page } from 'playwright';
import type { ExpectedBrowserReplies, ExpectedReply } from './provider-reply-coverage.ts';

const invitationReplies: ExpectedReply[] = [
  { transport: 'direct', method: 'POST', path: /^\/api\/invitations$/u,
    label: 'owner invitations', minimum: 2 },
];
const joinReply: ExpectedReply = {
  transport: 'direct', method: 'POST', path: /^\/members\/join$/u, label: 'invitation acceptance',
};
const providerReplies: ExpectedReply[] = [
  { transport: 'page', method: 'GET', path: /^\/api\/org\/providers$/u,
    label: 'Models & providers' },
  { transport: 'page', method: 'POST', path: /^\/api\/org\/providers$/u,
    label: 'provider creation and model selection', minimum: 2 },
  { transport: 'page', method: 'POST', path: /^\/api\/org\/providers\/[^/]+\/key$/u,
    label: 'both key saves', minimum: 2 },
  { transport: 'page', method: 'GET', path: /^\/api\/org\/providers\/[^/]+\/verify$/u,
    label: 'priced test quote' },
  { transport: 'page', method: 'POST', path: /^\/api\/org\/providers\/[^/]+\/verify$/u,
    label: 'reachability checks and priced test', minimum: 3 },
  { transport: 'page', method: 'POST', path: /^\/api\/org\/providers\/[^/]+\/bindings$/u,
    label: 'chat default selection' },
  { transport: 'page', method: 'POST', path: /^\/api\/org\/providers\/[^/]+\/drain$/u,
    label: 'pause new calls' },
  { transport: 'page', method: 'POST', path: /^\/api\/org\/providers\/[^/]+\/switch-on$/u,
    label: 'switch on member chat' },
  { transport: 'direct', method: 'GET', path: /^\/api\/org\/providers$/u,
    label: 'provider inventory read' },
  { transport: 'direct', method: 'GET', path: /^\/api\/org\/providers\/[^/]+$/u,
    label: 'provider verification and model selection reads' },
  { transport: 'direct', method: 'GET', path: /^\/api\/org\/providers\/[^/]+\/bindings$/u,
    label: 'provider binding read' },
];
const assistantSetupReplies: ExpectedReply[] = [
  { transport: 'direct', method: 'POST', path: /^\/api\/groups$/u, label: 'group creation' },
  { transport: 'direct', method: 'POST', path: /^\/api\/groups\/[^/]+$/u,
    label: 'group membership' },
  { transport: 'direct', method: 'GET', path: /^\/api\/groups\/[^/]+\/changes\/[^/]+$/u,
    label: 'group membership receipt' },
  { transport: 'direct', method: 'POST', path: /^\/api\/assistants$/u,
    label: 'assistant creation' },
  { transport: 'direct', method: 'GET', path: /^\/api\/assistants\/[^/]+\/changes\/[^/]+$/u,
    label: 'assistant creation receipt' },
];
const adminBudgetReplies: ExpectedReply[] = [
  { transport: 'page', method: 'GET', path: /^\/api\/org\/models$/u,
    label: 'Spending page reads', minimum: 2 },
  { transport: 'page', method: 'POST', path: /^\/api\/org\/models$/u,
    label: 'budget saves at both widths', minimum: 4 },
  { transport: 'page', method: 'GET', path: /^\/api\/org\/history$/u,
    label: 'Change history page reads', minimum: 2 },
  { transport: 'page', method: 'GET', path: /^\/api\/org\/history\/[^/]+$/u,
    label: 'turn spending details at both widths', minimum: 2 },
  { transport: 'direct', method: 'GET', path: /^\/api\/org\/models$/u,
    label: 'budget projection reads', minimum: 2 },
  { transport: 'direct', method: 'GET', path: /^\/api\/org\/history$/u,
    label: 'admin turn history reads', minimum: 2 },
];
const memberBudgetReplies: ExpectedReply[] = [
  { transport: 'page', method: 'GET', path: /^\/api\/conversations\/[^/]+\/messages$/u,
    label: 'chat history on screen', minimum: 2 },
  { transport: 'page', method: 'POST', path: /^\/api\/conversations\/[^/]+\/messages$/u,
    label: 'charged and refused member turns at both widths', minimum: 4 },
  { transport: 'page', method: 'GET', path: /^\/api\/conversations\/[^/]+\/budget-stops$/u,
    label: 'member budget refusal reads', minimum: 2 },
  { transport: 'direct', method: 'GET', path: /^\/api\/assistants\/[^/]+$/u,
    label: 'shared assistant availability reads', minimum: 2 },
  { transport: 'direct', method: 'POST', path: /^\/api\/conversations$/u,
    label: 'shared assistant session creation', minimum: 2 },
  { transport: 'direct', method: 'GET', path: /^\/api\/conversations\/[^/]+\/changes\/[^/]+$/u,
    label: 'shared assistant session receipts', minimum: 2 },
  { transport: 'direct', method: 'GET', path: /^\/api\/conversations\/[^/]+\/messages$/u,
    label: 'member turn feed reads', minimum: 2 },
  { transport: 'direct', method: 'GET', path: /^\/api\/conversations\/[^/]+\/history$/u,
    label: 'member turn history reads', minimum: 2 },
];
const memberChatReply: ExpectedReply = {
  transport: 'page', method: 'POST', path: /^\/api\/conversations\/[^/]+\/messages$/u,
  label: 'member chat sends', minimum: 2,
};

export function providerJourneyCoverage(owner: Page, admin: Page, member: Page,
  budget: boolean): ExpectedBrowserReplies {
  const ownerReplies = [...invitationReplies];
  const adminReplies = [joinReply];
  const memberReplies = [joinReply];
  if (budget) {
    ownerReplies.push(...providerReplies, ...assistantSetupReplies);
    adminReplies.push(...adminBudgetReplies);
    memberReplies.push(...memberBudgetReplies);
  } else {
    adminReplies.push(...providerReplies);
    memberReplies.push(memberChatReply);
  }
  return new Map([[owner, ownerReplies], [admin, adminReplies], [member, memberReplies]]);
}
